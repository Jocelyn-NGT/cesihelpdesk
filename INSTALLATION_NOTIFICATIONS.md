# Mise à jour : emails automatiques et suppression des comptes

Cette version conserve le menu d'affectation, l'export PDF et le filtre des incidents non terminés.
**La copie du site et `npm run build` ne suffisent pas : la base et les fonctions serveur doivent aussi être mises à jour.**

## Comportement

- Dans **Comptes**, la colonne **Emails incidents** choisit un seul compte actif. Cocher une autre personne remplace le destinataire précédent. Cette adresse reçoit les deux types d'emails.
- Le vendredi à **08:00, Europe/Paris**, le serveur envoie le récapitulatif des incidents déclarés depuis la borne du dernier récapitulatif livré. Pour le premier, la période commence le vendredi précédent à 08:00. Un incident déjà traité reste inclus s'il a été déclaré pendant cette période. Le message contient un lien vers Suivi, avec les dates de la période et tous les statuts.
- Même sans nouvel incident, un récapitulatif est envoyé avec un lien vers Suivi.
- Lors de la déclaration d'un incident présentant un risque, une alerte part immédiatement via la file serveur, sans attendre vendredi ni garder le navigateur ouvert.
- Un seul destinataire, et pas de reprise silencieuse des anciennes variables `ALERT_RECIPIENTS` ou `WEEKLY_RECIPIENTS`. Sans case cochée, les messages restent en attente.
- En cas de panne, nouvelle tentative après 5 minutes, puis toutes les heures après 12 essais. La tâche de contrôle tourne toutes les minutes et rattrape le dernier vendredi dû après interruption. L'heure reste 08:00 en été comme en hiver.
- La corbeille supprime le compte de connexion et son profil. La confirmation avertit que tous ses incidents seront remis en **Non assigné** ; les incidents ne sont pas supprimés. Son propre compte et le dernier administrateur actif sont protégés. Une désactivation retire aussi la personne des destinataires.

## Ordre d'installation sur la VM existante

1. Sauvegarder la base avant migration, puis copier le projet mis à jour dans le dépôt utilisé par la VM. Conserver les fichiers `.env` de la VM et `.env.local` du site.
2. Depuis le dossier du projet sur la VM, appliquer les migrations en attente :

   ```bash
   bash deploy/scripts/appliquer-migrations.sh
   ```

   La nouvelle migration est `supabase/migrations/20260928140000_notifications_et_suppression_comptes.sql`. **Ne pas utiliser `db reset`.** Si l'installation ne suit pas l'historique de migrations du dépôt, faire appliquer ce seul fichier par l'administrateur de la base.

3. Les fonctions sont montées depuis le dépôt dans la configuration Docker de ce projet. Redémarrer le service pour charger les fichiers modifiés :

   ```bash
   docker restart supabase-edge-functions
   bash deploy/scripts/configurer-notifications.sh
   ```

4. Vérifier les variables du service de fonctions. Le transport doit être `MAIL_TRANSPORT=smtp` pour envoyer réellement ; `console` ne fait que simuler. Il faut `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASSWORD`, `SMTP_FROM`, `FUNCTION_SECRET` et `PUBLIC_APP_URL`. Dans la surcouche Docker du projet, `SMTP_PASSWORD` vient de `SMTP_PASS` et `SMTP_FROM` de `SMTP_ADMIN_EMAIL`. Utiliser la procédure existante `deploy/scripts/basculer-smtp.sh` si nécessaire. Après changement d'environnement, recréer le service depuis `/opt/supabase` avec `docker compose up -d --force-recreate functions`.

   `PUBLIC_APP_URL` doit être l'adresse accessible aux destinataires, en incluant le préfixe du site s'il existe (ex. `https://exemple.fr/cesihelpdesk`). Ne pas utiliser `localhost`.

5. Publier le site avec la procédure habituelle ou, pour un essai sur le PC :

   ```powershell
   npm.cmd install
   npm.cmd run build
   npm.cmd run dev
   ```

6. Se connecter en administrateur et cocher le destinataire dans **Comptes**.

## Si la base est sur Supabase hébergé

Faire appliquer la migration SQL, déployer les fonctions `comptes` et `notifications` avec le dossier partagé `_shared` et leurs réglages `verify_jwt=false` du `config.toml`. L'authentification est contrôlée dans les fonctions (session administrateur ou secret serveur).

Configurer les secrets de fonctions cités ci-dessus. Dans `public.configuration`, renseigner `url_fonction_notifications` avec l'URL `/functions/v1/notifications` de ce projet et `secret_notifications` avec la même valeur que `FUNCTION_SECRET`. Les extensions `pg_cron` et `pg_net`, déjà requises par les migrations initiales du projet, doivent être actives. La tâche est créée par la migration ; aucune automatisation sur le PC n'est nécessaire.

## Vérifications après activation

- Vérifier la case du destinataire après rechargement de Comptes.
- Déclarer un incident de test clairement identifié, avec risque coché, et vérifier sa réception. Ce test envoie réellement un email au compte sélectionné si SMTP est actif.
- Consulter les tables côté administrateur SQL :

  ```sql
  select id, mode, etat, tentatives, erreur, prochain_essai
  from public.notifications_jobs order by id desc limit 20;
  select type, destinataires, statut, erreur, envoye_le
  from public.email_log order by id desc limit 20;
  select jobname, schedule, active from cron.job
  where jobname in ('recap-hebdomadaire', 'notifications-incidents');
  ```

  `notifications-incidents` doit être actif et l'ancienne tâche `recap-hebdomadaire` supprimée. `envoye` signifie que le serveur SMTP a accepté le message ; vérifier également sa réception et les indésirables. `simule` n'envoie aucun email et ne marque pas une période comme réellement livrée.

- Pour essayer le récapitulatif avant vendredi, un administrateur SQL peut créer explicitement un envoi de test avec cette commande. **Cela envoie un vrai récapitulatif au destinataire et avance la borne du dernier récapitulatif livré si SMTP réussit** :

  ```sql
  with j as (
    insert into public.notifications_jobs(cle, mode, debut, fin)
    values ('recap-test:' || gen_random_uuid(), 'recap', now()-interval '7 days', now())
    returning id
  )
  select public.appeler_notifications(jsonb_build_object('job_id', id)) from j;
  ```

- Pour la suppression, utiliser un compte de test distinct du compte connecté, lui attribuer un incident de test, puis vérifier la confirmation, la disparition du compte et le retour à « Non assigné ».

La file empêche les doubles traitements ordinaires. Comme tout envoi SMTP sans clé d'idempotence, une panne juste après acceptation de l'email et avant l'enregistrement de la réussite peut provoquer un doublon à la reprise.

## Vérifications réalisées dans l'environnement de développement

Compilation et lint du site ; migration et scénarios métier dans PostgreSQL embarqué (PGlite), avec les appels réseau et cron simulés ; fonctions Edge vérifiées et exécutées avec des services simulés (autorisations, destinataire, alerte, pagination, lien et suppression). Les dépendances Deno distantes étant inaccessibles depuis cet environnement, la vérification complète avec leurs imports réels reste à effectuer au déploiement. Aucun compte réel supprimé, aucun email réel envoyé et aucun déploiement de production effectué. Le transport SMTP et le fonctionnement de pg_net sur votre serveur restent à valider après installation.
