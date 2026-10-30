---
title: Clash AI — VoxCPM Derja beta
emoji: 🔊
colorFrom: yellow
colorTo: yellow
sdk: gradio
sdk_version: 6.30.0
python_version: '3.12'
app_file: app.py
hardware: zero-gpu
pinned: false
short_description: Démo gratuite de synthèse vocale tunisienne VoxCPM
---

# VoxCPM Derja beta

Démo Gradio isolée du Worker Clash AI. Elle accepte uniquement du texte en arabe, n’accepte aucune photo et ne modifie pas le parcours vocal existant.

## Limites de la version gratuite

- ZeroGPU est partagé et soumis aux quotas Hugging Face ; la disponibilité, la file d’attente et la durée ne sont pas garanties.
- La réservation maximale s’adapte au nombre de segments : 60 s pour une phrase courte, puis +30 s par segment, plafonnée à 150 s. Les paramètres de qualité (`cfg_value` et 20 pas d’inférence) restent inchangés ; une durée trop courte peut toutefois interrompre une génération lente.
- Quand le Worker Clash AI appelle ce Space avec le jeton Hugging Face configuré côté serveur, les générations non mises en cache consomment le quota du compte associé à ce jeton, partagé entre tous les utilisateurs de Clash AI. Les visiteurs ne reçoivent pas chacun un quota indépendant ; le cache évite de resynthétiser un texte vocalisé identique pendant sa période de validité.
- Le modèle d’environ 9,5 Go peut rallonger le démarrage à froid. Une démo ZeroGPU n’est pas un service de production garanti pour tous les utilisateurs.
- Le Space public reçoit le texte Derja que le visiteur colle. N’y colle pas de données personnelles.

## Installation

Créer un Space Gradio avec le matériel ZeroGPU, puis pousser `app.py`, `gpu_budget.py`, `README.md` et `requirements.txt` dans ce dossier. L’accès ZeroGPU gratuit à l’hébergement dépend de l’éligibilité du compte Hugging Face.

Le modèle est `Code-Quasar/voxcpm-tn` (licence Apache-2.0). La démo utilise le préfixe `(Tunisian Dialect)` et les paramètres retenus pendant les essais VoxCPM. Un court WAV synthétique de référence, généré par le même modèle et validé comme plus tunisien, est passé à `reference_wav_path` pour stabiliser le timbre entre les segments. Il sert au conditionnement vocal ; il n’ajoute pas de texte parlé à la sortie.
