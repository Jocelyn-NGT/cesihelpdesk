/**
 * Gestion des comptes : invitation, réinitialisation et suppression définitive.
 *
 * Invitation et réinitialisation produisent un LIEN, rendu à l'administrateur. Aucune n'envoie
 * d'e-mail : Supabase Auth n'a pas de relais SMTP sur cette instance (le
 * transport piloté par MAIL_TRANSPORT ne sert qu'aux notifications d'incidents).
 * L'administrateur transmet donc le lien par le canal de son choix — ce qui
 * évite au passage qu'une adresse saisie de travers parte dans la nature sans
 * que personne s'en aperçoive.
 *
 * POURQUOI UNE FONCTION EDGE : créer un compte et fabriquer un lien de
 * récupération demandent la clé de service, qui contourne toutes les politiques
 * RLS. Elle ne peut donc pas vivre dans le navigateur. Ces opérations se
 * faisaient jusqu'ici en SSH sur la VM (`deploy/scripts/creer-compte-admin.sh`),
 * hors de portée d'un administrateur qui n'a que l'application sous la main.
 *
 * SÉCURITÉ : la fonction est servie avec `verify_jwt = false` — la clé publiable
 * EST un JWT valide, présent dans le bundle JavaScript de tous les visiteurs, si
 * bien que la vérification amont ne filtrerait personne. Le contrôle est fait
 * ici : le jeton de l'appelant est validé auprès de Supabase Auth, puis son
 * profil doit être un administrateur ACTIF. C'est la règle de la politique
 * `utilisateurs_gestion_admin`, appliquée au seul endroit qui détient la clé de
 * service.
 *
 * UN SEUL TYPE DE LIEN, « recovery », pour les deux actions : l'invité comme
 * l'oublieux arrivent sur le même écran « choisissez votre mot de passe ». Le
 * lien pointe vers l'application et porte le jeton HACHÉ, que le navigateur
 * échange contre une session (`verifyOtp`). On évite ainsi la redirection
 * `/auth/v1/verify` de Supabase Auth, dont la cible doit figurer dans une liste
 * blanche (`ADDITIONAL_REDIRECT_URLS`) qu'il faudrait tenir à jour.
 */

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

// L'application et l'API partagent le même domaine en production : aucun
// préflight n'a lieu. Ces en-têtes servent au développement local, où Vite
// (5173) et Supabase (54321) sont deux origines distinctes.
const ENTETES_CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}

interface CorpsRequete {
  action?: 'inviter' | 'reinitialiser' | 'supprimer'
  id?: string
  email?: string
  nom_complet?: string
  role?: 'admin' | 'technicien'
}

const reponse = (corps: unknown, status = 200) =>
  new Response(JSON.stringify(corps), {
    status,
    headers: { ...ENTETES_CORS, 'Content-Type': 'application/json' },
  })

/**
 * Mot de passe initial d'un compte invité.
 *
 * Il n'est communiqué à personne : l'invité choisit le sien depuis le lien.
 * Créer le compte sans aucun mot de passe laisserait une identité incomplète
 * dans `auth.users` si l'invitation restait sans suite.
 */
const motDePasseAleatoire = () =>
  Array.from(crypto.getRandomValues(new Uint8Array(24)), octet => octet.toString(16).padStart(2, '0')).join('')

/** Rend une cause d'erreur lisible (une erreur PostgREST n'est pas une `Error`). */
const decrire = (cause: unknown): string => {
  if (cause instanceof Error) return cause.message
  if (cause && typeof cause === 'object') {
    const { message, details, hint, code } = cause as Record<string, unknown>
    const morceaux = [message, details, hint, code && `(code ${code})`].filter(Boolean)
    if (morceaux.length) return morceaux.join(' — ')
    return JSON.stringify(cause)
  }
  return String(cause)
}

Deno.serve(async requete => {
  if (requete.method === 'OPTIONS') return new Response(null, { status: 204, headers: ENTETES_CORS })
  if (requete.method !== 'POST') return reponse({ erreur: 'Méthode non autorisée.' }, 405)

  const url = Deno.env.get('SUPABASE_URL') ?? ''
  const cleService = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''
  const urlApplication = (Deno.env.get('PUBLIC_APP_URL') ?? '').replace(/\/+$/, '')

  if (!url || !cleService) return reponse({ erreur: 'Fonction mal configurée : clé de service absente.' }, 500)
  // Sans elle, le lien ne mènerait nulle part : mieux vaut refuser que livrer à
  // l'administrateur une adresse qu'il transmettra pour rien.


  const admin = createClient(url, cleService, { auth: { persistSession: false, autoRefreshToken: false } })

  // ---------------------------------------------------------------------
  // 1. Qui appelle ?
  // ---------------------------------------------------------------------
  const jeton = (requete.headers.get('Authorization') ?? '').replace(/^Bearer\s+/i, '').trim()
  if (!jeton) return reponse({ erreur: 'Accès refusé.' }, 401)

  const { data: { user }, error: erreurJeton } = await admin.auth.getUser(jeton)
  if (erreurJeton || !user) return reponse({ erreur: 'Session expirée : reconnectez-vous.' }, 401)

  const { data: appelant, error: erreurProfil } = await admin
    .from('utilisateurs')
    .select('role, actif')
    .eq('id', user.id)
    .maybeSingle()

  if (erreurProfil) return reponse({ erreur: decrire(erreurProfil) }, 500)
  if (!appelant || !appelant.actif || appelant.role !== 'admin') {
    return reponse({ erreur: 'Cette opération est réservée aux administrateurs.' }, 403)
  }

  // ---------------------------------------------------------------------
  // 2. Que demande-t-il ?
  // ---------------------------------------------------------------------
  const corps: CorpsRequete = await requete.json().catch(() => ({}))
  if (corps.action === 'supprimer') {
    if (!corps.id || !/^[0-9a-f-]{36}$/i.test(corps.id)) return reponse({ erreur: 'Identifiant invalide.' }, 400)
    if (corps.id === user.id) return reponse({ erreur: 'Vous ne pouvez pas supprimer votre propre compte.' }, 409)
    const { data: cible, error: erreurCible } = await admin.from('utilisateurs').select('id, role, actif').eq('id', corps.id).maybeSingle()
    if (erreurCible) return reponse({ erreur: decrire(erreurCible) }, 500)
    if (!cible) return reponse({ erreur: 'Compte introuvable.' }, 404)
    if (cible.role === 'admin' && cible.actif) {
      const { count, error } = await admin.from('utilisateurs').select('id', { count: 'exact', head: true }).eq('role', 'admin').eq('actif', true)
      if (error) return reponse({ erreur: decrire(error) }, 500)
      if ((count ?? 0) <= 1) return reponse({ erreur: 'Impossible de supprimer le dernier administrateur actif.' }, 409)
    }
    // Une seule opération Auth : cascade transactionnelle vers le profil,
    // puis ON DELETE SET NULL sur les incidents. Le trigger protège aussi
    // le dernier administrateur en cas de requêtes concurrentes.
    const { error } = await admin.auth.admin.deleteUser(corps.id)
    if (error) return reponse({ erreur: decrire(error) }, 500)
    return reponse({ supprime: true })
  }
  if (!urlApplication) return reponse({ erreur: 'Fonction mal configurée : PUBLIC_APP_URL absent.' }, 500)
  const email = (corps.email ?? '').trim().toLowerCase()
  if (!email) return reponse({ erreur: 'Adresse e-mail manquante.' }, 400)

  try {
    if (corps.action === 'inviter') {
      const nomComplet = (corps.nom_complet ?? '').trim()
      if (!nomComplet) return reponse({ erreur: 'Le nom complet est requis.' }, 400)
      const role = corps.role === 'admin' ? 'admin' : 'technicien'

      // `email_confirm` : aucun e-mail de confirmation ne partira, et un compte
      // non confirmé ne peut pas se voir fabriquer de lien de récupération.
      // Le nom et le rôle passent par les métadonnées : c'est là que le
      // déclencheur `gerer_nouvel_utilisateur()` les lit pour créer la ligne de
      // `public.utilisateurs`.
      const { error } = await admin.auth.admin.createUser({
        email,
        password: motDePasseAleatoire(),
        email_confirm: true,
        user_metadata: { nom_complet: nomComplet, role },
      })

      if (error) {
        const dejaPris = (error as { code?: string }).code === 'email_exists'
          || /already been registered|already exists/i.test(error.message)
        if (dejaPris) {
          return reponse({
            erreur: 'Un compte utilise déjà cette adresse. Produisez-lui plutôt un lien de mot de passe depuis sa ligne.',
          }, 409)
        }
        throw error
      }
    } else if (corps.action === 'reinitialiser') {
      // Un lien pour un compte désactivé ouvrirait une session incapable de
      // rien lire (les politiques RLS exigent `actif`) : cela ressemblerait à
      // un lien cassé plutôt qu'à un accès coupé.
      const { data: cible, error } = await admin
        .from('utilisateurs')
        .select('actif')
        .eq('email', email)
        .maybeSingle()

      if (error) throw error
      if (!cible) return reponse({ erreur: 'Aucun compte ne porte cette adresse.' }, 404)
      if (!cible.actif) {
        return reponse({ erreur: 'Ce compte est désactivé : réactivez-le avant de lui produire un lien.' }, 409)
      }
    } else {
      return reponse({ erreur: 'Action inconnue.' }, 400)
    }

    // -------------------------------------------------------------------
    // 3. Le lien
    // -------------------------------------------------------------------
    const { data, error } = await admin.auth.admin.generateLink({ type: 'recovery', email })
    if (error) throw error

    const jetonHache = data.properties?.hashed_token
    if (!jetonHache) throw new Error("Supabase Auth n'a pas renvoyé de jeton de récupération.")

    // Le jeton voyage dans le FRAGMENT (#) : il n'apparaît ni dans les journaux
    // du serveur, ni dans l'en-tête Referer d'une éventuelle ressource tierce.
    return reponse({
      lien: `${urlApplication}/definir-mot-de-passe#token=${encodeURIComponent(jetonHache)}`,
      email,
    })
  } catch (cause) {
    const detail = decrire(cause)
    console.error('[comptes] échec :', detail)
    return reponse({ erreur: detail }, 500)
  }
})
