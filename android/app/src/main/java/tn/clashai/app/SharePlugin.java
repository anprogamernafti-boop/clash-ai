package tn.clashai.app;

import android.app.Activity;
import android.content.ContentValues;
import android.content.Intent;
import android.net.Uri;
import android.os.Build;
import android.os.Environment;
import android.provider.MediaStore;
import android.util.Base64;
import android.util.Log;

import androidx.core.content.FileProvider;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.io.File;
import java.io.FileOutputStream;
import java.io.OutputStream;

/**
 * Clash AI — partage et enregistrement de fichiers depuis la WebView.
 *
 * Pourquoi ce greffon est indispensable : la WebView Android n'implémente PAS la Web Share API
 * (`navigator.canShare` / `navigator.share`) et ignore les téléchargements déclenchés par
 * `<a download>` sur une URL `blob:` — l'utilisateur voyait « Vidéo prête » sans qu'aucun fichier
 * n'apparaisse et sans qu'aucune feuille de partage ne s'ouvre. Passer par du natif est le seul
 * moyen d'ouvrir WhatsApp avec la vidéo jointe.
 *
 * Côté web : Capacitor.Plugins.ClashShare.<méthode>({ ... })
 *
 *   partager({ base64, filename, mimeType, text })  -> ouvre la feuille de partage d'Android
 *   enregistrer({ base64, filename, mimeType })     -> écrit dans Téléchargements
 */
@CapacitorPlugin(name = "ClashShare")
public class SharePlugin extends Plugin {

    /** Écrit le contenu base64 dans le cache de l'application et renvoie le fichier. */
    private File ecrireFichier(String base64, String nom) throws Exception {
        File dossier = new File(getContext().getCacheDir(), "partage");
        if (!dossier.exists() && !dossier.mkdirs()) throw new Exception("dossier de partage inaccessible");
        /* On neutralise tout caractère de chemin : un nom d'image vient du réseau. */
        String sur = (nom == null || nom.trim().isEmpty())
                ? "clash-ai.bin"
                : nom.trim().replaceAll("[^A-Za-z0-9._-]", "_");
        File fichier = new File(dossier, sur);
        byte[] donnees = Base64.decode(base64, Base64.DEFAULT);
        try (FileOutputStream sortie = new FileOutputStream(fichier)) {
            sortie.write(donnees);
        }
        return fichier;
    }

    @PluginMethod
    public void partager(PluginCall call) {
        String base64 = call.getString("base64");
        if (base64 == null || base64.isEmpty()) {
            call.reject("Aucun contenu à partager.", "VIDE");
            return;
        }
        String nom = call.getString("filename", "clash-ai.mp4");
        String mime = call.getString("mimeType", "video/mp4");
        String texte = call.getString("text", "");

        try {
            File fichier = ecrireFichier(base64, nom);
            Uri uri = FileProvider.getUriForFile(
                    getContext(), getContext().getPackageName() + ".fileprovider", fichier);

            Intent envoi = new Intent(Intent.ACTION_SEND);
            envoi.setType(mime);
            envoi.putExtra(Intent.EXTRA_STREAM, uri);
            if (texte != null && !texte.isEmpty()) envoi.putExtra(Intent.EXTRA_TEXT, texte);
            envoi.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);

            /* On lance depuis l'ACTIVITÉ quand elle existe : depuis Android 10, un démarrage
               depuis le contexte applicatif est refusé si l'app n'est pas visible, et le
               sélecteur resterait invisible. Le drapeau NEW_TASK n'est qu'un repli. */
            Intent choix = Intent.createChooser(envoi, "Partager le clash");
            Activity activite = getActivity();
            if (activite != null) {
                activite.startActivity(choix);
            } else {
                choix.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                getContext().startActivity(choix);
            }

            JSObject res = new JSObject();
            res.put("ok", true);
            res.put("partage", true);
            res.put("octets", fichier.length());
            call.resolve(res);
        } catch (Exception e) {
            Log.e("ClashShare", "partage impossible", e);
            call.reject("Partage impossible : " + e.getMessage(), "ECHEC");
        }
    }

    @PluginMethod
    public void enregistrer(PluginCall call) {
        String base64 = call.getString("base64");
        if (base64 == null || base64.isEmpty()) {
            call.reject("Aucun contenu à enregistrer.", "VIDE");
            return;
        }
        String nom = call.getString("filename", "clash-ai.mp4");
        String mime = call.getString("mimeType", "video/mp4");
        final byte[] donnees = Base64.decode(base64, Base64.DEFAULT);
        String sur = (nom == null || nom.trim().isEmpty())
                ? "clash-ai.bin" : nom.trim().replaceAll("[^A-Za-z0-9._-]", "_");

        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                /* Android 10+ : on passe par MediaStore, sans aucune permission de stockage. */
                ContentValues valeurs = new ContentValues();
                valeurs.put(MediaStore.Downloads.DISPLAY_NAME, sur);
                valeurs.put(MediaStore.Downloads.MIME_TYPE, mime);
                Uri cible = getContext().getContentResolver()
                        .insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, valeurs);
                if (cible == null) throw new Exception("MediaStore a refusé l'enregistrement");
                try (OutputStream os = getContext().getContentResolver().openOutputStream(cible)) {
                    if (os == null) throw new Exception("flux d'écriture indisponible");
                    os.write(donnees);
                }
                JSObject res = new JSObject();
                res.put("ok", true);
                res.put("emplacement", "Téléchargements");
                res.put("nom", sur);
                call.resolve(res);
            } else {
                /* Android 9 et avant : dossier privé de l'application. */
                File dossier = getContext().getExternalFilesDir(Environment.DIRECTORY_DOWNLOADS);
                if (dossier == null) dossier = getContext().getFilesDir();
                File fichier = new File(dossier, sur);
                try (FileOutputStream sortie = new FileOutputStream(fichier)) {
                    sortie.write(donnees);
                }
                JSObject res = new JSObject();
                res.put("ok", true);
                res.put("emplacement", fichier.getAbsolutePath());
                res.put("nom", sur);
                call.resolve(res);
            }
        } catch (Exception e) {
            Log.e("ClashShare", "enregistrement impossible", e);
            call.reject("Enregistrement impossible : " + e.getMessage(), "ECHEC");
        }
    }
}
