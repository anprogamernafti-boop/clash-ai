package tn.clashai.app;

import android.app.Activity;
import android.util.Log;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/**
 * Clash AI — pont entre la page web (TypeScript/JavaScript) et le moteur Google Play Billing.
 *
 * Côté web : Capacitor.Plugins.ClashBilling.<méthode>(options)
 *
 * Méthodes exposées :
 *   getProducts()                        -> { products: [...], premiumPurchasable, packPurchasable }
 *   purchase({ productId })              -> { purchases: [...] }   (résolu à la fermeture de la fenêtre Play)
 *   restore()                            -> { purchases: [...] }   (droits encore actifs)
 *   finishPurchase({ productId, purchaseToken }) -> { done: true, mode: 'consume' | 'acknowledge' }
 *   status()                             -> { connected, library }
 */
@CapacitorPlugin(name = "ClashBilling")
public class BillingPlugin extends Plugin {

    private BillingManager manager;

    @Override
    public void load() {
        try {
            manager = new BillingManager(getContext());
        } catch (RuntimeException e) {
            manager = null;
            Log.e("ClashBilling", "Google Play Billing indisponible au démarrage", e);
        }
    }

    private boolean requireManager(PluginCall call) {
        if (manager != null) return true;
        call.reject("Google Play Billing est indisponible sur cet appareil.", "BILLING_INDISPONIBLE");
        return false;
    }

    @PluginMethod
    public void status(final PluginCall call) {
        if (!requireManager(call)) return;
        manager.connecter(new BillingManager.Callback() {
            @Override
            public void ok(JSObject data) {
                call.resolve(data);
            }

            @Override
            public void fail(String code, String message) {
                call.reject(message, code);
            }
        });
    }

    @PluginMethod
    public void getProducts(final PluginCall call) {
        if (!requireManager(call)) return;
        manager.produits(new BillingManager.Callback() {
            @Override
            public void ok(JSObject data) {
                call.resolve(data);
            }

            @Override
            public void fail(String code, String message) {
                call.reject(message, code);
            }
        });
    }

    @PluginMethod
    public void purchase(final PluginCall call) {
        if (!requireManager(call)) return;
        String productId = call.getString("productId");
        if (productId == null || productId.length() == 0) {
            call.reject("Paramètre « productId » manquant.", "PRODUIT_MANQUANT");
            return;
        }
        Activity activity = getActivity();
        if (activity == null) {
            call.reject("Aucune activité Android attachée.", "ACTIVITE_ABSENTE");
            return;
        }
        // L'utilisateur peut rester plusieurs minutes dans la fenêtre Play : on garde l'appel ouvert.
        call.setKeepAlive(true);

        manager.acheter(activity, productId, new BillingManager.Callback() {
            @Override
            public void ok(JSObject data) {
                call.resolve(data);
            }

            @Override
            public void fail(String code, String message) {
                call.reject(message, code);
            }
        });
    }

    @PluginMethod
    public void restore(final PluginCall call) {
        if (!requireManager(call)) return;
        call.setKeepAlive(true);
        manager.restaurer(new BillingManager.Callback() {
            @Override
            public void ok(JSObject data) {
                call.resolve(data);
            }

            @Override
            public void fail(String code, String message) {
                call.reject(message, code);
            }
        });
    }

    @PluginMethod
    public void finishPurchase(final PluginCall call) {
        if (!requireManager(call)) return;
        String productId = call.getString("productId");
        String token = call.getString("purchaseToken");
        if (token == null || token.length() == 0) {
            call.reject("Paramètre « purchaseToken » manquant.", "JETON_MANQUANT");
            return;
        }
        call.setKeepAlive(true);

        manager.finaliser(productId, token, new BillingManager.Callback() {
            @Override
            public void ok(JSObject data) {
                call.resolve(data);
            }

            @Override
            public void fail(String code, String message) {
                call.reject(message, code);
            }
        });
    }

    @Override
    protected void handleOnDestroy() {
        if (manager != null) {
            manager.liberer();
            manager = null;
        }
        super.handleOnDestroy();
    }
}
