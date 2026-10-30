# GUIDE DE DÉMARRAGE — Clash AI, de l'archive à l'application qui marche

Toutes les versions et tous les chemins cités ici correspondent exactement à cette archive
(vérifiés sur les fichiers réels) : Gradle **8.11.1** (`android/gradle/wrapper/gradle-wrapper.properties`),
AGP **8.9.1** (`android/build.gradle`), `compileSdk 36` / `minSdk 23` / `targetSdk 36`
(`android/variables.gradle`), Play Billing **9.1.0** (`billingVersion`), desugaring **2.1.4**,
`applicationId "tn.clashai.app"`, `versionName "1.0.0"` (`android/app/build.gradle`),
nom d'application **Clash AI** (`android/app/src/main/res/values/strings.xml`).

L'application fonctionne **dès l'installation** : l'IA de vision passe par le proxy Gemini
configuré (aucune clé à créer), et si elle est injoignable le moteur local **CLIP** prend le
relais automatiquement (téléchargement unique d'environ 155 Mo au premier clash). Tout le
reste (parrainage créditant le parrain, facturation Play) est optionnel et se branche ensuite.

---

## Phase 0 — Télécharger et décompresser

1. Télécharge `clash-ai-android.zip` (lien fourni dans la conversation).
2. Décompresse-le. Tu obtiens un dossier `clash-mobile/` contenant :
   - `www/` — l'application web (`index.html`, `pay-mode.js`, `billing-client.js`,
     `referral-client.js`, `privacy.html`, `sw.js`, `manifest.webmanifest`) ;
   - `android/` — le projet natif complet (wrapper Gradle inclus : `android/gradlew`,
     `android/gradle/wrapper/gradle-wrapper.jar`) ;
   - `backend/gemini/gemini-proxy-worker.js`, `referral-worker.js` — les backends Cloudflare ;
   - `test6.js`, `test7.js`, `test8.js` — les tests hors ligne ;
   - `README.md`, `capacitor.config.json`, `package.json`, icônes Play Store.

## Phase 1 — Installer les outils (une seule fois)

| Outil | Version | Utilité |
|---|---|---|
| **VS Code** | dernière | Éditer le code |
| **Node.js** | 20 LTS ou plus | `npm install`, `npx cap sync` |
| **Android Studio** | Meerkat (2024.3.1) ou plus récent | Installe le SDK Android ; requis pour AGP 8.9.1 |
| **JDK** | 17 ou 21 | Gradle 8.11.1 ; le JDK embarqué d'Android Studio suffit |

Dans Android Studio : *More Actions → SDK Manager* → onglet *SDK Platforms* : cocher
**Android 16 (API 36)** — c'est le `compileSdkVersion 36` du projet. Les Build-Tools et
Platform-Tools nécessaires sont installés automatiquement à la première compilation.

## Phase 2 — Ouvrir dans VS Code

3. Lance VS Code → **File → Open Folder…** → sélectionne le dossier `clash-mobile`
   (la racine, pas `android/` : ainsi tu vois le web ET le natif).
4. Extensions recommandées (VS Code propose celles du fichier `.vscode/extensions.json`
   inclus dans l'archive) :
   - **Extension Pack for Java** (vscjava.vscode-java-pack) — lecture du code Java natif ;
   - **Gradle for Java** (vscjava.vscode-gradle) — lancers de tâches Gradle depuis VS Code ;
   - **XML** (redhat.vscode-xml) — éditer le manifeste et les ressources.
5. Terminal intégré (**Terminal → New Terminal**) — tout se fait ensuite en lignes de commande.

## Phase 3 — Préparer le projet

6. Dans le terminal, à la racine `clash-mobile/` :
   ```bash
   npm ci
   npx cap sync android
   ```
   `npm install` installe l'outil Capacitor ; `npx cap sync android` recopie `www/` vers
   `android/app/src/main/assets/public/` (déjà à jour dans l'archive : cette étape n'est
   obligatoire qu'après avoir modifié `www/`).
7. *(Builds hors Android Studio)* vérifie que `android/local.properties`
   avec une ligne `sdk.dir=C\:\\Users\\<toi>\\AppData\\Local\\Android\\Sdk` (Windows) ou
   `sdk.dir=/home/<toi>/Android/Sdk` (Linux) — Android Studio le crée tout seul.
   Si tu changes de compte Windows, adapte cette ligne. Le script `setup-android.cmd` vérifie
   le SDK standard et réécrit ce fichier automatiquement.

## Phase 4 — Compiler

8. Toujours depuis la racine `clash-mobile/` :
   ```bash
   cd android
   ./gradlew assembleDebug        # Windows : gradlew.bat assembleDebug
   ```
   Sous Windows, `gradlew.bat` tente automatiquement les emplacements JDK usuels et le JDK
   embarqué d'Android Studio. Si aucun JDK n'est installé, installe JDK 17 ou 21 puis relance
   la commande (ou exécute `call ..\setup-java.cmd` depuis `android`).
   Si Gradle signale un composant Android manquant, exécute `setup-android.cmd` depuis la racine
   puis installe dans Android Studio : Android SDK Platform 36, Android SDK Build-Tools 36.0.0
   et Android SDK Platform-Tools.
   Le raccourci `build-debug.cmd` exécute ces vérifications, remet le projet en mode **Play Store**
   (facturation Google, bloc D17/WhatsApp masqué), synchronise `www/` puis lance `assembleDebug`
   avec `--stacktrace`.
   Pour produire l'APK **hors Play Store** (paiement D17 + redirection WhatsApp + code
   d'activation), lance `build-share-apk.cmd` : il écrit `clash-ai-partage.apk` à la racine, puis
   remet le projet en mode Play Store. Ne publie jamais cet APK sur le Play Store.
   Si PowerShell ne trouve pas `cmd`, utilise directement `. .\build-debug.ps1`.
   Si aucun JDK n'est installé, le script tente automatiquement l'installation de Microsoft
   OpenJDK 17 via `winget`.
   Premier lancement : Gradle 8.11.1 se télécharge puis tire les dépendances
   (comptez plusieurs centaines de Mo et quelques minutes).
9. L'APK de test est produit ici :
   ```
   android/app/build/outputs/apk/debug/app-debug.apk
   ```

## Phase 5 — Installer sur le téléphone

**Par câble :**
10. Sur le téléphone : *Paramètres → À propos* → toucher 7 fois « Numéro de build » →
    *Options pour développeurs* → activer **Débogage USB**.
11. Brancher, accepter la fenêtre d'autorisation, puis :
    ```bash
    adb install -r android/app/build/outputs/apk/debug/app-debug.apk
    ```
    (`adb` est dans `<SDK>/platform-tools/` ; « -r » remplace une version déjà installée.)

**Sans câble :** copier `app-debug.apk` sur le téléphone (mail, Drive…), ouvrir le fichier,
accepter « installer depuis cette source ». L'application s'ouvre et fonctionne
(moteur local, essais à vie, parrainage local).

## Phase 6 — Activer les services en ligne (optionnels, mais recommandés)

12. **Proxy Gemini (IA sans clé côté utilisateur)** — cf. README §6.5 : le proxy est déjà
    configuré dans `www/index.html` et garde la clé Google côté Worker. Depuis PowerShell, à la
    racine du projet, exécute `.\node_modules\.bin\wrangler.cmd login` si Wrangler n’est pas
    connecté. Si le secret manque, ajoute-le avec
    `.\node_modules\.bin\wrangler.cmd secret put GEMINI_KEY --config .\backend\gemini\wrangler.toml`, puis lance
    `.\deploy-gemini-proxy.ps1`. Aucun `APP_TOKEN` ne doit être intégré au site ou à l’APK.
    Après déploiement, vérifie les routes `/clash` et `/vocaliser`, puis supprime l’ancien secret
    `APP_TOKEN` s’il existe. Pour publier la page, utilise `.\deploy-pages-secure.ps1` ; pour
    reconstruire les assets Android, lance `npm run sync`.
13. **Parrainage créditant le parrain** — `referral-worker.js` : mêmes commandes (même
    namespace KV), puis `REF_API = 'https://…workers.dev'` dans `www/index.html`.
    Sans backend : le filleul reçoit son +1, le parrain n'est pas crédité (affiché honnêtement).
14. **Play Store / achats in-app** — Play Console : créer les produits `clash_premium_month`
    (**10 DT**, abonnement avec offre de base active) et `clash_pack_10` (3 DT, à l'unité),
    ajouter des testeurs de licence, publier en test interne. Vérifier que le profil de
    paiement + compte bancaire en devises + formulaire fiscal US sont remplis (sinon :
    ventes comptabilisées mais aucun versement).

## Phase 7 — Version publiée (Play Store)

15. Créer la clé de signature (une fois, à sauvegarder à vie) :
    ```bash
    keytool -genkey -v -keystore clash-ai.keystore -alias clashai -keyalg RSA -keysize 2048 -validity 10000
    ```
16. Android Studio : *Build → Generate Signed App Bundle / APK* → Android App Bundle
    (`clash-ai.aab`), versionCode déjà à 1 dans `android/app/build.gradle`.

---

## Dépannage des erreurs probables

| Erreur | Cause | Solution |
|---|---|---|
| `SDK location not found` | SDK non déclaré | Ouvre le projet une fois dans Android Studio (il crée `local.properties`), ou crée-le (étape 7) |
| `gradlew: Permission denied` | bit d'exécution perdu à la décompression | `chmod +x android/gradlew` |
| `Unsupported class file major version` / JDK refusé | JAVA_HOME pointe vers un vieux JDK | Installe JDK 17 ou 21 et pointe `JAVA_HOME` dessus |
| `Failed to install the following Android SDK platforms: platforms;android-36` | API 36 absente | SDK Manager → installer Android 16 (API 36) |
| `Task 'assembleDebug' not found` | commande lancée hors de `android/` | `cd android` d'abord |
| `Capacitor.Plugins.ClashBilling undefined` | APK compilé avant l'ajout du plugin | recompile (le plugin est enregistré dans `MainActivity.java`) |
| Catalogue Play vide / `PRODUIT_INTROUVABLE` | produits non créés ou app pas publiée en test | étape 14, identifiants à l'identique |
| `DEVELOPER_ERROR` à l'achat | applicationId ≠ Play Console | `tn.clashai.app` doit correspondre exactement |
| La fenêtre de paiement ne s'ouvre pas | compte Google sans Play Store (émulateur sans Play) | tester sur un appareil avec Google Play |
| Site web hors ligne après modif de `www/` | oubli de sync | `npx cap sync android` puis recompiler |

Coûts du premier build : téléchargement ≈ 0,5 à 1 Go (Gradle + SDK). Compte une connexion
stable. Les builds suivants sont rapides.
