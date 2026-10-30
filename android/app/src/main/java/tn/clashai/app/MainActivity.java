package tn.clashai.app;

import android.os.Bundle;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {

    @Override
    public void onCreate(Bundle savedInstanceState) {
        /* Un plugin local à l'application n'est PAS listé dans capacitor.plugins.json
           (généré par « cap sync » à partir des seuls paquets npm) : sans cet appel,
           Capacitor.Plugins.ClashBilling reste undefined et toute la facturation
           retombe sur « module absent ». L'enregistrement doit précéder super.onCreate(). */
        registerPlugin(BillingPlugin.class);
        /* La WebView Android n'a ni Web Share API ni Web Speech API : ces deux greffons fournissent
           le partage de la vidéo (WhatsApp) et la lecture du clash à voix haute. */
        registerPlugin(SharePlugin.class);
        registerPlugin(VoicePlugin.class);
        super.onCreate(savedInstanceState);
    }
}
