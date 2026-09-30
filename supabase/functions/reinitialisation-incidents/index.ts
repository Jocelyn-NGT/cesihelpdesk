/**
 * Réinitialisation complète des incidents.
 *
 * Réservée aux administrateurs actifs.
 *
 * Ordre :
 * 1. validation de la session ;
 * 2. contrôle du rôle administrateur ;
 * 3. récupération des chemins des photos ;
 * 4. suppression physique des photos via l'API Storage ;
 * 5. appel de la RPC reinitialiser_incidents().
 *
 * Les comptes, salles, catégories et paramètres sont conservés.
 */

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const ENTETES_CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}

const BUCKET_INCIDENTS = 'incidents'
const TAILLE_LOT = 100

const reponse = (corps: unknown, status = 200) =>
  new Response(JSON.stringify(corps), {
    status,
    headers: {
      ...ENTETES_CORS,
      'Content-Type': 'application/json',
    },
  })

const decrire = (cause: unknown): string => {
  if (cause instanceof Error) return cause.message

  if (cause && typeof cause === 'object') {
    const { message, details, hint, code } =
      cause as Record<string, unknown>

    const morceaux = [
      message,
      details,
      hint,
      code && `(code ${code})`,
    ].filter(Boolean)

    if (morceaux.length) return morceaux.join(' — ')

    return JSON.stringify(cause)
  }

  return String(cause)
}

Deno.serve(async requete => {
  if (requete.method === 'OPTIONS') {
    return new Response(null, {
      status: 204,
      headers: ENTETES_CORS,
    })
  }

  if (requete.method !== 'POST') {
    return reponse({ erreur: 'Méthode non autorisée.' }, 405)
  }

  const url = Deno.env.get('SUPABASE_URL') ?? ''
  const cleService = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''

  if (!url || !cleService) {
    return reponse({
      erreur: 'Fonction mal configurée : clé de service absente.',
    }, 500)
  }

  const admin = createClient(url, cleService, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
    },
  })

  // ---------------------------------------------------------------
  // 1. Vérification de la session
  // ---------------------------------------------------------------

  const jeton = (requete.headers.get('Authorization') ?? '')
    .replace(/^Bearer\s+/i, '')
    .trim()

  if (!jeton) {
    return reponse({ erreur: 'Accès refusé.' }, 401)
  }

  const {
    data: { user },
    error: erreurJeton,
  } = await admin.auth.getUser(jeton)

  if (erreurJeton || !user) {
    return reponse({
      erreur: 'Session expirée : reconnectez-vous.',
    }, 401)
  }

  // ---------------------------------------------------------------
  // 2. Vérification administrateur actif
  // ---------------------------------------------------------------

  const { data: appelant, error: erreurProfil } = await admin
    .from('utilisateurs')
    .select('role, actif')
    .eq('id', user.id)
    .maybeSingle()

  if (erreurProfil) {
    return reponse({ erreur: decrire(erreurProfil) }, 500)
  }

  if (!appelant || !appelant.actif || appelant.role !== 'admin') {
    return reponse({
      erreur: 'Cette opération est réservée aux administrateurs.',
    }, 403)
  }

  try {
    // -------------------------------------------------------------
    // 3. Récupération des photos avant suppression des tickets
    // -------------------------------------------------------------

    const { data: tickets, error: erreurTickets } = await admin
      .from('tickets')
      .select('image_chemin')
      .not('image_chemin', 'is', null)

    if (erreurTickets) throw erreurTickets

    const chemins = (tickets ?? [])
      .map(ticket => ticket.image_chemin)
      .filter((chemin): chemin is string =>
        typeof chemin === 'string' && chemin.length > 0
      )

    // -------------------------------------------------------------
    // 4. Suppression physique des photos par lots
    // -------------------------------------------------------------

    for (let debut = 0; debut < chemins.length; debut += TAILLE_LOT) {
      const lot = chemins.slice(debut, debut + TAILLE_LOT)

      const { error } = await admin.storage
        .from(BUCKET_INCIDENTS)
        .remove(lot)

      if (error) throw error
    }

    // -------------------------------------------------------------
    // 5. Réinitialisation transactionnelle de la base
    // -------------------------------------------------------------

    const { data: nombre, error: erreurReinitialisation } =
      await admin.rpc('reinitialiser_incidents')

    if (erreurReinitialisation) throw erreurReinitialisation

    const resultat = {
      reinitialise: true,
      incidents_supprimes: Number(nombre ?? 0),
      photos_supprimees: chemins.length,
    }

    console.log(
      '[reinitialisation-incidents]',
      JSON.stringify(resultat),
    )

    return reponse(resultat)
  } catch (cause) {
    const detail = decrire(cause)

    console.error(
      '[reinitialisation-incidents] échec :',
      detail,
    )

    return reponse({ erreur: detail }, 500)
  }
})
