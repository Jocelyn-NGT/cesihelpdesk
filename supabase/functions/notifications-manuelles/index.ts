/**
 * Envoi manuel d'incidents aux traitants.
 *
 * Le navigateur transmet uniquement les identifiants des incidents sélectionnés.
 * La fonction :
 * - vérifie que l'appelant est un membre actif du personnel ;
 * - recharge les incidents depuis la base ;
 * - récupère les adresses des traitants côté serveur ;
 * - regroupe les incidents par traitant ;
 * - envoie un seul e-mail par traitant.
 *
 * Un incident non attribué ou attribué à un compte inactif/sans e-mail
 * n'est pas envoyé et est signalé dans la réponse.
 */

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { envoyer } from '../_shared/courriel.ts'

const ENTETES_CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
}

interface CorpsRequete {
  ticket_ids?: unknown
}

interface LigneTicket {
  id: number
  titre: string
  created_at: string
  assigne_a_id: string | null
  salles: { nom: string } | null
  utilisateurs: {
    id: string
    nom_complet: string
    email: string
    actif: boolean
  } | null
}

interface GroupeTraitant {
  nom: string
  email: string
  tickets: LigneTicket[]
}

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

const echapperHtml = (valeur: string): string =>
  valeur
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;')

const formaterDate = (valeur: string): string =>
  new Intl.DateTimeFormat('fr-FR', {
    dateStyle: 'short',
    timeStyle: 'short',
    timeZone: 'Europe/Paris',
  }).format(new Date(valeur))

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
  const urlApplication =
    (Deno.env.get('PUBLIC_APP_URL') ?? '').replace(/\/+$/, '')

  if (!url || !cleService) {
    return reponse({
      erreur: 'Fonction mal configurée : clé de service absente.',
    }, 500)
  }

  if (!/^https?:\/\//.test(urlApplication)) {
    return reponse({
      erreur: 'PUBLIC_APP_URL doit contenir l’adresse publique du site.',
    }, 500)
  }

  const admin = createClient(url, cleService, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
    },
  })

  // ------------------------------------------------------------
  // 1. Vérification de l'utilisateur connecté
  // ------------------------------------------------------------

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

  const { data: appelant, error: erreurProfil } = await admin
    .from('utilisateurs')
    .select('id, actif, role')
    .eq('id', user.id)
    .maybeSingle()

  if (erreurProfil) {
    return reponse({ erreur: decrire(erreurProfil) }, 500)
  }

  if (
    !appelant ||
    !appelant.actif ||
    !['admin', 'technicien'].includes(appelant.role)
  ) {
    return reponse({
      erreur: 'Cette opération est réservée au personnel actif.',
    }, 403)
  }

  // ------------------------------------------------------------
  // 2. Validation des incidents demandés
  // ------------------------------------------------------------

  const corps: CorpsRequete =
    await requete.json().catch(() => ({}))

  if (!Array.isArray(corps.ticket_ids)) {
    return reponse({
      erreur: 'Liste des incidents absente.',
    }, 400)
  }

  const ids = [
    ...new Set(
      corps.ticket_ids
        .map(id => Number(id))
        .filter(id => Number.isSafeInteger(id) && id > 0),
    ),
  ]

  if (ids.length === 0) {
    return reponse({
      erreur: 'Aucun incident valide sélectionné.',
    }, 400)
  }

  // Limite volontaire pour éviter un envoi massif accidentel.
  if (ids.length > 100) {
    return reponse({
      erreur: 'Vous ne pouvez pas envoyer plus de 100 incidents à la fois.',
    }, 400)
  }

  // ------------------------------------------------------------
  // 3. Chargement des incidents et des traitants
  // ------------------------------------------------------------

  const { data, error: erreurTickets } = await admin
    .from('tickets')
    .select(`
      id,
      titre,
      created_at,
      assigne_a_id,
      salles ( nom ),
      utilisateurs (
        id,
        nom_complet,
        email,
        actif
      )
    `)
    .in('id', ids)
    .order('created_at', { ascending: true })
    .order('id', { ascending: true })

  if (erreurTickets) {
    return reponse({
      erreur: decrire(erreurTickets),
    }, 500)
  }

  const tickets = (data ?? []) as unknown as LigneTicket[]

  const groupes = new Map<string, GroupeTraitant>()
  const ignores: number[] = []

  for (const ticket of tickets) {
    const traitant = ticket.utilisateurs

    if (
      !ticket.assigne_a_id ||
      !traitant ||
      !traitant.actif ||
      !traitant.email
    ) {
      ignores.push(ticket.id)
      continue
    }

    const existant = groupes.get(traitant.id)

    if (existant) {
      existant.tickets.push(ticket)
    } else {
      groupes.set(traitant.id, {
        nom: traitant.nom_complet,
        email: traitant.email,
        tickets: [ticket],
      })
    }
  }

  // IDs demandés mais inexistants.
  const idsTrouves = new Set(tickets.map(ticket => ticket.id))

  for (const id of ids) {
    if (!idsTrouves.has(id)) {
      ignores.push(id)
    }
  }

  if (groupes.size === 0) {
    return reponse({
      erreur: 'Aucun des incidents sélectionnés ne possède de traitant actif avec une adresse e-mail.',
      incidents_ignores: [...new Set(ignores)],
    }, 400)
  }

  // ------------------------------------------------------------
  // 4. Un e-mail par traitant
  // ------------------------------------------------------------

  let emailsEnvoyes = 0
  let incidentsEnvoyes = 0

  const echecs: {
    traitant: string
    erreur: string
  }[] = []

  for (const groupe of groupes.values()) {
    const lignesTexte = groupe.tickets
      .map(ticket => {
        const salle = ticket.salles?.nom ?? 'Salle inconnue'

        return [
          `Incident n° ${ticket.id} — ${ticket.titre}`,
          `Lieu : ${salle}`,
          `Déclaré le : ${formaterDate(ticket.created_at)}`,
          `Consulter : ${urlApplication}/incident/${ticket.id}`,
        ].join('\n')
      })
      .join('\n\n')

    const lignesHtml = groupe.tickets
      .map(ticket => {
        const salle = ticket.salles?.nom ?? 'Salle inconnue'
        const lien = `${urlApplication}/incident/${ticket.id}`

        return `
          <li style="margin-bottom:18px;">
            <strong>
              Incident n° ${ticket.id} —
              ${echapperHtml(ticket.titre)}
            </strong><br>
            Lieu : ${echapperHtml(salle)}<br>
            Déclaré le : ${echapperHtml(formaterDate(ticket.created_at))}<br>
            <a href="${echapperHtml(lien)}">Consulter l'incident</a>
          </li>
        `
      })
      .join('')

    const nombre = groupe.tickets.length

    const sujet = nombre === 1
      ? 'Helpdesk CESI — Incident à traiter'
      : `Helpdesk CESI — ${nombre} incidents à traiter`

    const texte = [
      `Bonjour ${groupe.nom},`,
      '',
      nombre === 1
        ? 'Un incident vous a été attribué sur le Helpdesk CESI.'
        : `${nombre} incidents vous ont été attribués sur le Helpdesk CESI.`,
      '',
      lignesTexte,
      '',
      `Accéder au suivi : ${urlApplication}/suivi`,
      '',
      'Ceci est un message automatique du Helpdesk CESI.',
    ].join('\n')

    const html = `
      <p>Bonjour ${echapperHtml(groupe.nom)},</p>

      <p>
        ${
          nombre === 1
            ? 'Un incident vous a été attribué sur le Helpdesk CESI.'
            : `${nombre} incidents vous ont été attribués sur le Helpdesk CESI.`
        }
      </p>

      <ul>
        ${lignesHtml}
      </ul>

      <p>
        <a href="${echapperHtml(`${urlApplication}/suivi`)}">
          Accéder au suivi des incidents
        </a>
      </p>

      <p style="color:#666;font-size:12px;">
        Ceci est un message automatique du Helpdesk CESI.
      </p>
    `

    try {
      const resultat = await envoyer({
        destinataires: [groupe.email],
        sujet,
        texte,
        html,
      })

      if (resultat.statut === 'echec') {
        echecs.push({
          traitant: groupe.nom,
          erreur: resultat.erreur ?? 'Échec de l’envoi.',
        })
        continue
      }

      emailsEnvoyes += 1
      incidentsEnvoyes += nombre
    } catch (cause) {
      echecs.push({
        traitant: groupe.nom,
        erreur: decrire(cause),
      })
    }
  }

  // ------------------------------------------------------------
  // 5. Résultat envoyé au navigateur
  // ------------------------------------------------------------

  if (emailsEnvoyes === 0 && echecs.length > 0) {
    return reponse({
      erreur: 'Aucun e-mail n’a pu être envoyé.',
      emails_envoyes: 0,
      incidents_envoyes: 0,
      incidents_ignores: [...new Set(ignores)],
      echecs,
    }, 503)
  }

  return reponse({
    statut: echecs.length > 0 ? 'partiel' : 'envoye',
    emails_envoyes: emailsEnvoyes,
    incidents_envoyes: incidentsEnvoyes,
    incidents_ignores: [...new Set(ignores)],
    echecs,
  })
})
