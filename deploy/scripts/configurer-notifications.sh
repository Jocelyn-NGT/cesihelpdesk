#!/usr/bin/env bash
# Relie la base aux fonctions Edge appelées par pg_net : « notifications » et
# « maintenance » (purge des photos).
#
# Le déclencheur d'alerte (risque d'accident), la tâche pg_cron du vendredi et
# la purge nocturne des photos appellent ces fonctions via pg_net, avec l'URL et
# le secret stockés dans public.configuration. Ici les URL sont INTERNES au
# réseau Docker : le conteneur `db` joint la passerelle `api-gw` par son nom,
# sans passer par Internet ni par NPM — une alerte part même si le DNS public
# est en panne.
#
# Usage (sur la VM) :
#   bash deploy/scripts/configurer-notifications.sh           # configure
#   bash deploy/scripts/configurer-notifications.sh --tester  # + traitement des messages en attente et simulation de purge
#
# Variables : SUPABASE_DIR (défaut /opt/supabase).

set -euo pipefail

SUPABASE_DIR="${SUPABASE_DIR:-/opt/supabase}"
URL_INTERNE="http://api-gw:8000/functions/v1/notifications"
URL_INTERNE_MAINTENANCE="http://api-gw:8000/functions/v1/maintenance"

[ -f "$SUPABASE_DIR/.env" ] || { echo "Pile absente : $SUPABASE_DIR/.env introuvable." >&2; exit 1; }
lire_env() { grep "^$1=" "$SUPABASE_DIR/.env" | head -n1 | cut -d= -f2- | tr -d '\r"'"'"; }
FUNCTION_SECRET="$(lire_env FUNCTION_SECRET)"
[ -n "$FUNCTION_SECRET" ] || { echo "FUNCTION_SECRET vide dans $SUPABASE_DIR/.env." >&2; exit 1; }

psql_db() { docker exec -i supabase-db psql -U postgres -d postgres -v ON_ERROR_STOP=1 -q "$@"; }

echo "→ Écriture dans public.configuration"
# Variables psql : aucun problème de guillemets, quel que soit le secret.
psql_db -v url="$URL_INTERNE" -v url_maintenance="$URL_INTERNE_MAINTENANCE" -v secret="$FUNCTION_SECRET" <<'SQL'
update public.configuration set valeur = :'url'             where cle = 'url_fonction_notifications';
update public.configuration set valeur = :'url_maintenance' where cle = 'url_fonction_maintenance';
update public.configuration set valeur = :'secret'          where cle = 'secret_notifications';
SQL
psql_db -c "select cle, case when cle = 'secret_notifications' then '(défini, ' || length(valeur) || ' car.)' else valeur end as valeur from public.configuration order by cle;"

if [ "${1:-}" = "--tester" ]; then
  echo "→ Planification et traitement des messages en attente"
  psql_db -c 'select public.planifier_notifications();'
  echo "   Aucun récapitulatif artificiel n'est créé ; seuls les messages arrivés à échéance partent."
  echo "→ Dernières lignes d'email_log"
  psql_db -c "select type, destinataires, statut, erreur, envoye_le from public.email_log order by id desc limit 3;"
  echo "   En mode console, le corps du message est dans : docker logs supabase-edge-functions --tail 40"
  echo "→ Simulation de la purge des photos (rien n'est supprimé)"
  reponse="$(curl -s -X POST "http://127.0.0.1:8001/functions/v1/maintenance" \
    -H "x-secret-maintenance: $FUNCTION_SECRET" -H "Content-Type: application/json" \
    -d '{"mode":"purge_photos","simulation":true}')"
  echo "   $reponse"
fi

echo
echo "Test de bout en bout : déclarez un incident en cochant « Risque d'accident »,"
echo "puis vérifiez public.email_log (statut 'simule' en mode console, 'envoye' en SMTP)."
