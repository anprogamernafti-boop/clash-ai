package tn.clashai.app;

import android.app.Activity;
import android.content.Context;
import android.os.Handler;
import android.os.Looper;
import android.util.Log;

import com.android.billingclient.api.AcknowledgePurchaseParams;
import com.android.billingclient.api.BillingClient;
import com.android.billingclient.api.BillingClientStateListener;
import com.android.billingclient.api.BillingFlowParams;
import com.android.billingclient.api.BillingResult;
import com.android.billingclient.api.ConsumeParams;
import com.android.billingclient.api.ConsumeResponseListener;
import com.android.billingclient.api.PendingPurchasesParams;
import com.android.billingclient.api.ProductDetails;
import com.android.billingclient.api.ProductDetailsResponseListener;
import com.android.billingclient.api.Purchase;
import com.android.billingclient.api.PurchasesResponseListener;
import com.android.billingclient.api.PurchasesUpdatedListener;
import com.android.billingclient.api.QueryProductDetailsParams;
import com.android.billingclient.api.QueryProductDetailsResult;
import com.android.billingclient.api.QueryPurchasesParams;
import com.getcapacitor.JSObject;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

import java.util.ArrayList;
import java.util.Collections;
import java.util.HashMap;
import java.util.List;
import java.util.Map;

/**
 * Clash AI — moteur Google Play Billing.
 *
 * Écrit pour la Play Billing Library 9.1.0. Les API supprimées en 8.0.0 ne sont PAS utilisées,
 * la bibliothèque ne compilerait pas :
 *   - querySkuDetailsAsync / SkuDetails / SkuDetailsParams  -> queryProductDetailsAsync / ProductDetails
 *   - enablePendingPurchases() sans paramètre               -> enablePendingPurchases(PendingPurchasesParams)
 *   - queryPurchasesAsync(String, listener)                 -> queryPurchasesAsync(QueryPurchasesParams, listener)
 *   - queryPurchaseHistory()                                -> supprimé, géré côté serveur
 *
 * Deux produits, deux natures :
 *   - clash_premium_month : ABONNEMENT          -> on ACQUITTE (acknowledge), le droit reste tant que l'abo est actif.
 *   - clash_pack_10       : PRODUIT CONSOMMABLE -> on CONSOMME (consume) pour permettre un rachat.
 *
 * Ordre volontaire : l'achat n'est finalisé QUE lorsque la couche web a confirmé avoir enregistré
 * le droit. Un achat non finalisé est automatiquement remboursé par Google au bout de 3 jours.
 *
 * Les listes (produits, achats) sont transmises à la couche web sous forme de chaîne JSON :
 * seules les primitives put(String, String|int|boolean) du pont Capacitor sont utilisées, ce qui
 * évite toute dépendance à une signature de méthode qui changerait d'une version à l'autre.
 *
 * ⚠️ Vérification côté serveur : ce module fait confiance à la réponse de Google sur l'appareil.
 * Pour un produit qui rapporte réellement, il faut en plus vérifier le purchaseToken auprès de
 * l'API Google Play Developer (purchases.subscriptionsv2.get / purchases.products.get) sur un
 * serveur, avant d'accorder le droit.
 */
public class BillingManager implements PurchasesUpdatedListener {

    private static final String TAG = "ClashBilling";

    /** Version de la bibliothèque déclarée dans android/variables.gradle. */
    public static final String LIB_VERSION = "9.1.0";

    /** Identifiants À CRÉER dans Play Console. Une seule lettre d'écart => requête vide. */
    public static final String PRODUCT_PREMIUM = "clash_premium_month";
    public static final String PRODUCT_PACK = "clash_pack_10";

    /** Reconnexion avec attente croissante (le service Play peut être momentanément indisponible). */
    private static final long[] BACKOFF_MS = {0L, 1000L, 2000L, 4000L, 8000L, 15000L};

    public interface Callback {
        void ok(JSObject data);
        void fail(String code, String message);
    }

    private final Context context;
    private final Handler main = new Handler(Looper.getMainLooper());
    private final Map<String, ProductDetails> catalogue = new HashMap<>();

    private BillingClient client;
    private int tentative = 0;
    private boolean connexionEnCours = false;
    private Callback acheteurEnAttente;

    public BillingManager(Context context) {
        this.context = context.getApplicationContext();
    }

    /* ------------------------------------------------------------------ client */

    private void creerClient() {
        if (client != null) return;
        client = BillingClient.newBuilder(context)
                .setListener(this)
                // Exigé depuis la 8.0.0 : la variante sans paramètre a été supprimée.
                .enablePendingPurchases(PendingPurchasesParams.newBuilder().enableOneTimeProducts().build())
                // Ajoutée en 8.0.0 : la bibliothèque retente seule la connexion au service.
                .enableAutoServiceReconnection()
                .build();
    }

    /** Établit la connexion si nécessaire, puis rappelle ok(). */
    public void connecter(Callback cb) {
        creerClient();
        if (client.isReady()) {
            cb.ok(etat());
            return;
        }
        if (connexionEnCours) {
            cb.fail("CONNEXION_EN_COURS", "Une connexion au service Google Play est déjà en cours.");
            return;
        }
        connexionEnCours = true;
        final long delai = BACKOFF_MS[Math.min(tentative, BACKOFF_MS.length - 1)];

        main.postDelayed(new Runnable() {
            @Override
            public void run() {
                client.startConnection(new BillingClientStateListener() {
                    @Override
                    public void onBillingSetupFinished(BillingResult r) {
                        connexionEnCours = false;
                        if (r.getResponseCode() == BillingClient.BillingResponseCode.OK) {
                            tentative = 0;
                            cb.ok(etat());
                        } else {
                            tentative++;
                            cb.fail("SETUP_" + r.getResponseCode(),
                                    texteErreur(r) + " (tentative " + tentative + ")");
                        }
                    }

                    @Override
                    public void onBillingServiceDisconnected() {
                        connexionEnCours = false;
                        cb.fail("DECONNECTE", "Service Google Play déconnecté. Nouvel essai automatique au prochain appel.");
                    }
                });
            }
        }, delai);
    }

    private JSObject etat() {
        JSObject o = new JSObject();
        o.put("connected", client != null && client.isReady());
        o.put("library", LIB_VERSION);
        return o;
    }

    /* ----------------------------------------------------------------- produits */

    /** Interroge les deux produits, met le catalogue en cache et renvoie les prix localisés. */
    public void produits(final Callback cb) {
        connecter(new Callback() {
            @Override
            public void ok(JSObject d) {
                // Play Billing 9.x REFUSE de mélanger un ABONNEMENT et un PRODUIT À L'UNITÉ dans un
                // même appel : QueryProductDetailsParams.Builder.setProductList lève alors
                // IllegalArgumentException (« All products should be of the same product type »).
                // Non rattrapée, cette exception tue le processus au démarrage. On interroge donc
                // chaque nature séparément, puis on fusionne les deux catalogues.
                interroger(BillingClient.ProductType.SUBS, Collections.singletonList(PRODUCT_PREMIUM),
                        new ProductDetailsResponseListener() {
                    @Override
                    public void onProductDetailsResponse(BillingResult r1, QueryProductDetailsResult res1) {
                        if (r1.getResponseCode() != BillingClient.BillingResponseCode.OK) {
                            cb.fail("QUERY_" + r1.getResponseCode(), texteErreur(r1));
                            return;
                        }
                        interroger(BillingClient.ProductType.INAPP, Collections.singletonList(PRODUCT_PACK),
                                new ProductDetailsResponseListener() {
                            @Override
                            public void onProductDetailsResponse(BillingResult r2, QueryProductDetailsResult res2) {
                                if (r2.getResponseCode() != BillingClient.BillingResponseCode.OK) {
                                    cb.fail("QUERY_" + r2.getResponseCode(), texteErreur(r2));
                                    return;
                                }
                                List<ProductDetails> liste = new ArrayList<>();
                                if (res1 != null && res1.getProductDetailsList() != null) {
                                    liste.addAll(res1.getProductDetailsList());
                                }
                                if (res2 != null && res2.getProductDetailsList() != null) {
                                    liste.addAll(res2.getProductDetailsList());
                                }
                                repondreProduits(liste, cb);
                            }
                        });
                    }
                });
            }

            @Override
            public void fail(String code, String message) {
                cb.fail(code, message);
            }
        });
    }

    /** Interroge UNE seule nature de produit : exigence de Play Billing 9.x (pas de mélange). */
    private void interroger(String type, List<String> ids, ProductDetailsResponseListener l) {
        List<QueryProductDetailsParams.Product> demandes = new ArrayList<>();
        for (String id : ids) {
            demandes.add(QueryProductDetailsParams.Product.newBuilder()
                    .setProductId(id)
                    .setProductType(type)
                    .build());
        }
        try {
            client.queryProductDetailsAsync(
                    QueryProductDetailsParams.newBuilder().setProductList(demandes).build(), l);
        } catch (Exception e) {
            // Filet de sécurité : aucune erreur de facturation ne doit faire tomber l'application.
            Log.w(TAG, "queryProductDetailsAsync : " + e.getMessage());
            BillingResult err = BillingResult.newBuilder()
                    .setResponseCode(BillingClient.BillingResponseCode.ERROR)
                    .setDebugMessage(String.valueOf(e.getMessage()))
                    .build();
            l.onProductDetailsResponse(err, null);
        }
    }

    /** Construit la réponse du pont à partir des produits réellement renvoyés par Google. */
    private void repondreProduits(List<ProductDetails> liste, Callback cb) {
        catalogue.clear();
        JSONArray sortie = new JSONArray();

        for (ProductDetails pd : liste) {
            catalogue.put(pd.getProductId(), pd);

            String prix = "";
            boolean offreToken = false;

            if (BillingClient.ProductType.SUBS.equals(pd.getProductType())) {
                List<ProductDetails.SubscriptionOfferDetails> offres = pd.getSubscriptionOfferDetails();
                if (offres != null && !offres.isEmpty()) {
                    ProductDetails.SubscriptionOfferDetails offre = offres.get(0);
                    offreToken = offre.getOfferToken() != null;
                    if (offre.getPricingPhases() != null
                            && !offre.getPricingPhases().getPricingPhaseList().isEmpty()) {
                        prix = offre.getPricingPhases().getPricingPhaseList().get(0).getFormattedPrice();
                    }
                }
            } else if (pd.getOneTimePurchaseOfferDetails() != null) {
                prix = pd.getOneTimePurchaseOfferDetails().getFormattedPrice();
            }

            JSONObject o = new JSONObject();
            try {
                o.put("productId", pd.getProductId());
                o.put("title", pd.getTitle());
                o.put("type", pd.getProductType());
                o.put("price", prix);
                o.put("hasOfferToken", offreToken);
            } catch (JSONException e) {
                Log.w(TAG, "JSON produit : " + e.getMessage());
            }
            sortie.put(o);
        }

        JSObject data = new JSObject();
        data.put("productsJson", sortie.toString());
        data.put("count", liste.size());
        // Un abonnement sans offre (base plan) ne peut pas être acheté : on le signale
        // au lieu de laisser l'utilisateur devant un bouton inerte.
        data.put("premiumPurchasable", catalogue.containsKey(PRODUCT_PREMIUM));
        data.put("packPurchasable", catalogue.containsKey(PRODUCT_PACK));
        cb.ok(data);
    }

    /* -------------------------------------------------------------------- achat */

    public void acheter(final Activity activity, final String productId, Callback cb) {
        if (productId == null || productId.length() == 0) {
            cb.fail("PRODUIT_MANQUANT", "Aucun identifiant de produit fourni.");
            return;
        }
        this.acheteurEnAttente = cb;

        connecter(new Callback() {
            @Override
            public void ok(JSObject d) {
                ProductDetails pd = catalogue.get(productId);
                if (pd != null) {
                    lancer(activity, pd);
                    return;
                }
                // Catalogue vide (premier lancement) : on interroge d'abord, puis on relance.
                produits(new Callback() {
                    @Override
                    public void ok(JSObject d2) {
                        ProductDetails trouve = catalogue.get(productId);
                        if (trouve == null) {
                            acheteurEnAttente = null;
                            cb.fail("PRODUIT_INTROUVABLE",
                                    "Le produit « " + productId + " » n'existe pas ou n'est pas actif dans Play Console. "
                                    + "Vérifie l'identifiant exact et l'activation du produit.");
                            return;
                        }
                        lancer(activity, trouve);
                    }

                    @Override
                    public void fail(String code, String message) {
                        acheteurEnAttente = null;
                        cb.fail(code, message);
                    }
                });
            }

            @Override
            public void fail(String code, String message) {
                acheteurEnAttente = null;
                cb.fail(code, message);
            }
        });
    }

    private void lancer(Activity activity, ProductDetails pd) {
        BillingFlowParams.ProductDetailsParams.Builder b =
                BillingFlowParams.ProductDetailsParams.newBuilder().setProductDetails(pd);

        if (BillingClient.ProductType.SUBS.equals(pd.getProductType())) {
            List<ProductDetails.SubscriptionOfferDetails> offres = pd.getSubscriptionOfferDetails();
            if (offres == null || offres.isEmpty()) {
                Callback cb = acheteurEnAttente;
                acheteurEnAttente = null;
                if (cb != null) {
                    cb.fail("OFFRE_ABSENTE", "Abonnement sans offre (base plan) configurée dans Play Console.");
                }
                return;
            }
            // Le jeton d'offre est OBLIGATOIRE pour un abonnement. Interdit pour un produit à l'unité.
            b.setOfferToken(offres.get(0).getOfferToken());
        }

        final BillingFlowParams flux = BillingFlowParams.newBuilder()
                .setProductDetailsParamsList(Collections.singletonList(b.build()))
                .build();

        activity.runOnUiThread(new Runnable() {
            @Override
            public void run() {
                BillingResult r = client.launchBillingFlow(activity, flux);
                if (r.getResponseCode() != BillingClient.BillingResponseCode.OK) {
                    Callback cb = acheteurEnAttente;
                    acheteurEnAttente = null;
                    if (cb != null) cb.fail("FLOW_" + r.getResponseCode(), texteErreur(r));
                }
            }
        });
    }

    /** Appelé par Google à la fermeture de la fenêtre d'achat. */
    @Override
    public void onPurchasesUpdated(BillingResult r, List<Purchase> achats) {
        Callback cb = acheteurEnAttente;
        acheteurEnAttente = null;

        if (r.getResponseCode() == BillingClient.BillingResponseCode.USER_CANCELED) {
            if (cb != null) cb.fail("ANNULE_PAR_UTILISATEUR", "Achat annulé.");
            return;
        }
        if (r.getResponseCode() != BillingClient.BillingResponseCode.OK) {
            if (cb != null) cb.fail("ACHAT_" + r.getResponseCode(), texteErreur(r));
            return;
        }

        List<Purchase> liste = (achats == null) ? Collections.<Purchase>emptyList() : achats;
        JSObject data = new JSObject();
        data.put("purchasesJson", jsonAchats(liste));
        data.put("count", liste.size());
        if (cb != null) cb.ok(data);
    }

    /* ---------------------------------------------------------------- restauration */

    /** Relit tous les droits détenus (réinstallation, changement de téléphone, renouvellement). */
    public void restaurer(Callback cb) {
        connecter(new Callback() {
            @Override
            public void ok(JSObject d) {
                final List<Purchase> cumul = new ArrayList<>();
                final int[] restants = {2};

                PurchasesResponseListener collecteur = new PurchasesResponseListener() {
                    @Override
                    public void onQueryPurchasesResponse(BillingResult r, List<Purchase> achats) {
                        if (r.getResponseCode() == BillingClient.BillingResponseCode.OK && achats != null) {
                            for (Purchase p : achats) {
                                if (p.getPurchaseState() == Purchase.PurchaseState.PURCHASED) cumul.add(p);
                            }
                        }
                        restants[0]--;
                        if (restants[0] == 0) {
                            JSObject data = new JSObject();
                            data.put("purchasesJson", jsonAchats(cumul));
                            data.put("count", cumul.size());
                            cb.ok(data);
                        }
                    }
                };

                // Les achats déjà consommés ne sont PAS renvoyés ici : la restauration ne peut donc
                // pas recréditer deux fois un pack de clashs. Un abonnement actif, lui, est renvoyé.
                client.queryPurchasesAsync(QueryPurchasesParams.newBuilder()
                        .setProductType(BillingClient.ProductType.INAPP).build(), collecteur);
                client.queryPurchasesAsync(QueryPurchasesParams.newBuilder()
                        .setProductType(BillingClient.ProductType.SUBS).build(), collecteur);
            }

            @Override
            public void fail(String code, String message) {
                cb.fail(code, message);
            }
        });
    }

    /* ---------------------------------------------------------------- finalisation */

    /**
     * Finalise l'achat APRÈS confirmation d'enregistrement côté web.
     * Abonnement -> acknowledge. Pack consommable -> consume.
     */
    public void finaliser(final String productId, final String token, final Callback cb) {
        if (token == null || token.length() == 0) {
            cb.fail("JETON_MANQUANT", "Jeton d'achat absent.");
            return;
        }
        creerClient();

        if (PRODUCT_PACK.equals(productId)) {
            client.consumeAsync(ConsumeParams.newBuilder().setPurchaseToken(token).build(),
                    new ConsumeResponseListener() {
                        @Override
                        public void onConsumeResponse(BillingResult r, String t) {
                            if (r.getResponseCode() == BillingClient.BillingResponseCode.OK) {
                                JSObject o = new JSObject();
                                o.put("done", true);
                                o.put("mode", "consume");
                                cb.ok(o);
                            } else {
                                cb.fail("CONSUME_" + r.getResponseCode(), texteErreur(r));
                            }
                        }
                    });
        } else {
            client.acknowledgePurchase(AcknowledgePurchaseParams.newBuilder().setPurchaseToken(token).build(),
                    new com.android.billingclient.api.AcknowledgePurchaseResponseListener() {
                        @Override
                        public void onAcknowledgePurchaseResponse(BillingResult r) {
                            if (r.getResponseCode() == BillingClient.BillingResponseCode.OK) {
                                JSObject o = new JSObject();
                                o.put("done", true);
                                o.put("mode", "acknowledge");
                                cb.ok(o);
                            } else {
                                cb.fail("ACK_" + r.getResponseCode(), texteErreur(r));
                            }
                        }
                    });
        }
    }

    /* -------------------------------------------------------------------- outils */

    public void liberer() {
        if (client != null) {
            try {
                client.endConnection();
            } catch (Exception e) {
                Log.w(TAG, "endConnection : " + e.getMessage());
            }
            client = null;
        }
    }

    /** Sérialise une liste d'achats en chaîne JSON (jamais un objet de pont). */
    private String jsonAchats(List<Purchase> achats) {
        JSONArray arr = new JSONArray();
        for (Purchase p : achats) arr.put(achat(p));
        return arr.toString();
    }

    private JSONObject achat(Purchase p) {
        JSONObject o = new JSONObject();
        JSONArray ids = new JSONArray();
        try {
            for (String s : p.getProducts()) ids.put(s);
            o.put("orderId", p.getOrderId());
            o.put("purchaseToken", p.getPurchaseToken());
            o.put("acknowledged", p.isAcknowledged());
            o.put("autoRenewing", p.isAutoRenewing());
            o.put("state", p.getPurchaseState());
            o.put("quantity", p.getQuantity());
            o.put("purchaseTime", p.getPurchaseTime());
            o.put("products", ids);
            o.put("productId", p.getProducts().isEmpty() ? "" : p.getProducts().get(0));
        } catch (JSONException e) {
            Log.w(TAG, "JSON achat : " + e.getMessage());
        }
        return o;
    }

    private String texteErreur(BillingResult r) {
        String base = "Code " + r.getResponseCode();
        String debug = r.getDebugMessage();
        if (debug != null && debug.length() > 0) base = base + " — " + debug;
        switch (r.getResponseCode()) {
            case BillingClient.BillingResponseCode.BILLING_UNAVAILABLE:
                return base + " (Google Play indisponible sur cet appareil ou ce compte)";
            case BillingClient.BillingResponseCode.ITEM_UNAVAILABLE:
                return base + " (produit indisponible : pas encore activé dans Play Console)";
            case BillingClient.BillingResponseCode.ITEM_ALREADY_OWNED:
                return base + " (produit déjà possédé : utiliser la restauration)";
            case BillingClient.BillingResponseCode.DEVELOPER_ERROR:
                return base + " (paramètres incorrects ou applicationId ne correspondant pas à Play Console)";
            case BillingClient.BillingResponseCode.SERVICE_DISCONNECTED:
                return base + " (service déconnecté : réessaie)";
            case BillingClient.BillingResponseCode.NETWORK_ERROR:
                return base + " (problème réseau)";
            default:
                return base;
        }
    }
}
