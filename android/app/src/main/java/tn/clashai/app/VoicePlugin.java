package tn.clashai.app;

import android.app.Activity;
import android.content.Intent;
import android.os.Build;
import android.os.Bundle;
import android.speech.tts.TextToSpeech;
import android.speech.tts.UtteranceProgressListener;
import android.util.Base64;
import android.util.Log;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileInputStream;
import java.util.ArrayList;
import java.util.List;
import java.util.Locale;

/**
 * Clash AI — lecture du clash à voix haute, via la synthèse vocale d'Android.
 *
 * Pourquoi ce greffon est indispensable : la WebView Android n'expose PAS la Web Speech API
 * (`window.speechSynthesis` est absent), alors que Chrome sur le même téléphone l'a — d'où le
 * message « la synthèse vocale n'est pas disponible » dans l'application.
 *
 * On fait lire le TEXTE ARABE (punchline_ar fournie par le modèle) avec une voix ARABE : aucun
 * moteur ne sait lire la derja écrite en lettres latines. Le moteur arabe améliore la lecture des
 * consonnes, mais ne garantit pas un accent tunisien. Si l'appareil n'a pas de voix arabe, le
 * client envoie la version translittérée et `langue: 'fr'`.
 *
 * Côté web : Capacitor.Plugins.ClashVoice.<méthode>({ ... })
 *
 *   dispo()                          -> { tts, arabe, moteur, langues: [...] }
 *   parler({ text, langue, vitesse, hauteur }) -> { ok, langue, dispoLangue }
 *   stop()                           -> {}
 *   installer()                      -> ouvre l'écran d'installation des voix
 */
@CapacitorPlugin(name = "ClashVoice")
public class VoicePlugin extends Plugin {

    private TextToSpeech tts;
    private boolean pret = false;

    @Override
    public void load() {
        try {
            tts = new TextToSpeech(getContext(), new TextToSpeech.OnInitListener() {
                @Override
                public void onInit(int statut) {
                    pret = (statut == TextToSpeech.SUCCESS);
                    if (!pret) Log.w("ClashVoice", "moteur de synthèse vocale indisponible");
                }
            });
        } catch (RuntimeException e) {
            tts = null;
            pret = false;
            Log.e("ClashVoice", "initialisation impossible", e);
        }
    }

    private boolean requireTts(PluginCall call) {
        if (tts != null && pret) return true;
        call.reject("La synthèse vocale n'est pas disponible sur cet appareil.", "TTS_INDISPONIBLE");
        return false;
    }

    private boolean arabeDisponible() {
        if (tts == null || !pret) return false;
        int dispo = tts.isLanguageAvailable(new Locale("ar"));
        return dispo == TextToSpeech.LANG_AVAILABLE
                || dispo == TextToSpeech.LANG_COUNTRY_AVAILABLE
                || dispo == TextToSpeech.LANG_COUNTRY_VAR_AVAILABLE;
    }

    private Locale localeArabe() {
        if (tts != null && pret && Build.VERSION.SDK_INT >= Build.VERSION_CODES.LOLLIPOP) {
            try {
                for (Locale disponible : tts.getAvailableLanguages()) {
                    if (disponible != null && "ar".equals(disponible.getLanguage())
                            && "TN".equals(disponible.getCountry())) {
                        return new Locale("ar", "TN");
                    }
                }
            } catch (RuntimeException e) {
                Log.w("ClashVoice", "impossible de lister les locales TTS", e);
            }
        }
        return new Locale("ar");
    }

    private Locale localePour(String langue) {
        return (langue != null && langue.startsWith("ar")) ? localeArabe() : Locale.getDefault();
    }

    @PluginMethod
    public void dispo(PluginCall call) {
        JSObject res = new JSObject();
        res.put("tts", tts != null && pret);
        res.put("arabe", arabeDisponible());
        Locale localeAr = localeArabe();
        res.put("arabeLocale", localeAr.toString());
        res.put("arabeTunisien", "TN".equals(localeAr.getCountry()));
        res.put("moteur", tts != null ? tts.getDefaultEngine() : null);
        try {
            List<String> langues = new ArrayList<>();
            if (tts != null && Build.VERSION.SDK_INT >= Build.VERSION_CODES.LOLLIPOP) {
                for (Locale l : tts.getAvailableLanguages()) {
                    if (l != null) langues.add(l.toString());
                }
            }
            res.put("langues", langues.size() > 40 ? langues.subList(0, 40) : langues);
        } catch (RuntimeException e) {
            res.put("langues", new ArrayList<String>());
        }
        call.resolve(res);
    }

    @PluginMethod
    public void parler(PluginCall call) {
        if (!requireTts(call)) return;
        String texte = call.getString("text");
        if (texte == null || texte.trim().isEmpty()) {
            call.reject("Aucun texte à lire.", "VIDE");
            return;
        }
        String langue = call.getString("langue", "ar");
        Locale locale = localePour(langue);

        int dispo = tts.setLanguage(locale);
        if (dispo == TextToSpeech.LANG_MISSING_DATA || dispo == TextToSpeech.LANG_NOT_SUPPORTED) {
            /* Voix absente : on le dit clairement pour que l'utilisateur puisse l'installer. */
            JSObject res = new JSObject();
            res.put("ok", false);
            res.put("dispoLangue", false);
            res.put("langue", locale.toString());
            res.put("raison", dispo == TextToSpeech.LANG_MISSING_DATA
                    ? "données de voix absentes" : "langue non prise en charge");
            call.resolve(res);
            return;
        }

        Double v = call.getDouble("vitesse");
        Double h = call.getDouble("hauteur");
        tts.setSpeechRate(v == null ? 0.95f : v.floatValue());
        tts.setPitch(h == null ? 1.0f : h.floatValue());

        int code = tts.speak(texte, TextToSpeech.QUEUE_FLUSH, null, "clash");
        JSObject res = new JSObject();
        res.put("ok", code == TextToSpeech.SUCCESS);
        res.put("dispoLangue", true);
        res.put("langue", locale.toString());
        res.put("moteur", tts.getDefaultEngine());
        call.resolve(res);
    }

    @PluginMethod
    public void stop(PluginCall call) {
        if (tts != null) tts.stop();
        call.resolve();
    }

    private PluginCall syntheseEnCours = null;

    /**
     * Rend la phrase DANS UN FICHIER audio au lieu de la jouer : c'est ce qui permet de mettre la
     * voix tunisienne à l'intérieur de la vidéo. La WebView ne peut pas capturer une synthèse
     * vocale ; le natif, lui, sait l'écrire sur disque, et la page la relit puis la mixe dans
     * l'enregistrement (Web Audio -> MediaStreamDestination).
     *
     * Renvoie { ok, base64, octets, mime, langue }.
     */
    @PluginMethod
    public void synthetiser(PluginCall call) {
        if (!requireTts(call)) return;
        final String texte = call.getString("text");
        if (texte == null || texte.trim().isEmpty()) {
            call.reject("Aucun texte à synthétiser.", "VIDE");
            return;
        }
        String langue = call.getString("langue", "ar");
        final Locale locale = localePour(langue);

        int dispo = tts.setLanguage(locale);
        if (dispo == TextToSpeech.LANG_MISSING_DATA || dispo == TextToSpeech.LANG_NOT_SUPPORTED) {
            JSObject res = new JSObject();
            res.put("ok", false);
            res.put("dispoLangue", false);
            res.put("langue", locale.toString());
            res.put("raison", dispo == TextToSpeech.LANG_MISSING_DATA
                    ? "données de voix absentes" : "langue non prise en charge");
            call.resolve(res);
            return;
        }

        Double v = call.getDouble("vitesse");
        Double h = call.getDouble("hauteur");
        tts.setSpeechRate(v == null ? 0.95f : v.floatValue());
        tts.setPitch(h == null ? 1.0f : h.floatValue());

        final File fichier = new File(getContext().getCacheDir(), "voix-clash.wav");
        if (fichier.exists() && !fichier.delete()) {
            Log.w("ClashVoice", "ancien fichier de voix non supprimé");
        }

        syntheseEnCours = call;
        final String id = "clash-video";
        tts.setOnUtteranceProgressListener(new UtteranceProgressListener() {
            @Override
            public void onStart(String utteranceId) { /* rien */ }

            @Override
            public void onDone(String utteranceId) {
                if (!id.equals(utteranceId)) return;
                PluginCall enAttente = syntheseEnCours;
                syntheseEnCours = null;
                if (enAttente == null || enAttente.isReleased()) return;
                try {
                    byte[] donnees = lire(fichier);
                    if (donnees.length == 0) throw new Exception("fichier audio vide");
                    JSObject res = new JSObject();
                    res.put("ok", true);
                    res.put("base64", Base64.encodeToString(donnees, Base64.NO_WRAP));
                    res.put("octets", donnees.length);
                    res.put("mime", "audio/wav");
                    res.put("langue", locale.toString());
                    res.put("moteur", tts.getDefaultEngine());
                    enAttente.resolve(res);
                } catch (Exception e) {
                    Log.e("ClashVoice", "lecture du fichier de voix impossible", e);
                    enAttente.reject("Lecture de la voix impossible : " + e.getMessage(), "ECHEC");
                }
            }

            @Override
            public void onError(String utteranceId) { echouer(utteranceId, 0); }

            @Override
            public void onError(String utteranceId, int code) { echouer(utteranceId, code); }

            private void echouer(String utteranceId, int code) {
                if (!id.equals(utteranceId)) return;
                PluginCall enAttente = syntheseEnCours;
                syntheseEnCours = null;
                if (enAttente == null || enAttente.isReleased()) return;
                enAttente.reject("Synthèse vocale impossible" + (code != 0 ? " (code " + code + ")" : ""), "ECHEC");
            }
        });

        Bundle params = new Bundle();
        int code = tts.synthesizeToFile(texte, params, fichier, id);
        if (code != TextToSpeech.SUCCESS) {
            syntheseEnCours = null;
            call.reject("Le moteur vocal refuse l'écriture dans un fichier.", "ECHEC");
        }
    }

    private static byte[] lire(File f) throws Exception {
        try (FileInputStream entree = new FileInputStream(f);
             ByteArrayOutputStream sortie = new ByteArrayOutputStream()) {
            byte[] tampon = new byte[8192];
            int n;
            while ((n = entree.read(tampon)) > 0) sortie.write(tampon, 0, n);
            return sortie.toByteArray();
        }
    }

    /** Démarre une activité de réglages : depuis l'activité si possible (voir SharePlugin). */
    private void ouvrirReglages(Intent i) {
        Activity activite = getActivity();
        if (activite != null) {
            activite.startActivity(i);
        } else {
            i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            getContext().startActivity(i);
        }
    }

    /** Ouvre l'écran système d'installation des données de voix (pour ajouter l'arabe). */
    @PluginMethod
    public void installer(PluginCall call) {
        try {
            ouvrirReglages(new Intent(TextToSpeech.Engine.ACTION_INSTALL_TTS_DATA));
            call.resolve();
        } catch (RuntimeException e) {
            try {
                ouvrirReglages(new Intent("com.android.settings.TTS_SETTINGS"));
                call.resolve();
            } catch (RuntimeException e2) {
                call.reject("Impossible d'ouvrir l'installation des voix.", "ECHEC");
            }
        }
    }

    @Override
    protected void handleOnDestroy() {
        if (tts != null) {
            try { tts.stop(); tts.shutdown(); } catch (RuntimeException e) { /* déjà arrêté */ }
            tts = null;
            pret = false;
        }
        super.handleOnDestroy();
    }
}
