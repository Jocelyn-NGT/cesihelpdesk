/**
 * Envoi des notifications par e-mail.
 *
 * Le serveur reçoit un job_id de la file notifications_jobs. Deux modes :
 * - `urgent` : alerte immédiate, déclenchée par la base à l'insertion d'un
 *   incident dont la case « Risque d'accident » est cochée ;
 * - `recap` : récapitulatif hebdomadaire, déclenché par pg_cron le vendredi
 *   à 08:00 Europe/Paris, avec verrou et reprise des échecs.
 *
 * POURQUOI LE DÉCLENCHEUR EST EN BASE ET NON DANS LE NAVIGATEUR :
 * l'ancienne version affichait « un email a été envoyé aux responsables » alors
 * qu'aucun envoi n'existait. Faire appeler cette fonction par le navigateur
 * reproduirait le même défaut sous une autre forme : l'onglet peut être fermé,
 * le réseau peut tomber, et personne ne serait prévenu. Déclenché par un
 * trigger Postgres, l'envoi est lié à l'écriture du ticket.
 *
 * SÉCURITÉ : la fonction est déployée avec `verify_jwt = false`. Vérifier le
 * JWT ne protégerait rien ici, puisque la clé publiable est un JWT valide
 * présent dans le bundle JavaScript envoyé à tous les visiteurs. L'accès est
 * donc contrôlé par un en-tête secret partagé avec la base.
 */

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { envoyer } from '../_shared/courriel.ts'
import { alerteUrgente, recapHebdomadaire, type TicketCourriel } from '../_shared/modeles.ts'

// FILET DE SÉCURITÉ. denomailer peut rejeter une promesse en dehors de tout
// `await` (erreur interne de connexion, vue sur STARTTLS). Sans ce filet, le
// worker Deno est tué, la base reçoit 503, et l'alerte est perdue SANS trace
// dans email_log — exactement ce que ce projet a corrigé une première fois.
// Avec lui, l'erreur est journalisée et la requête aboutit à un « echec »
// consigné.
globalThis.addEventListener('unhandledrejection', evenement => {
  console.error('[notifications] rejet non capturé :', evenement.reason)
  evenement.preventDefault()
})

interface Job {
  id: number
  mode: 'urgent' | 'recap'
  ticket_id: number | null
  debut: string | null
  fin: string | null
  verrou: string
}

type LigneTicket = Omit<TicketCourriel, 'salle' | 'types'> & {
  salles: { nom: string } | null
  ticket_categories: { categories_incident: { label: string } | null }[]
}

const SELECTION = `
  id, titre, demandeur_nom, demandeur_email, description,
  risque_accident, created_at,
  salles ( nom ),
  ticket_categories ( categories_incident ( label ) )
`

const aplatir = (ligne: LigneTicket): TicketCourriel => ({
  id: ligne.id,
  titre: ligne.titre,
  salle: ligne.salles?.nom ?? 'Salle inconnue',
  demandeur_nom: ligne.demandeur_nom,
  demandeur_email: ligne.demandeur_email,
  description: ligne.description,
  risque_accident: ligne.risque_accident,
  created_at: ligne.created_at,
  types: ligne.ticket_categories
    .map(lien => lien.categories_incident?.label)
    .filter((label): label is string => Boolean(label)),
})

const reponse = (corps: unknown, status = 200) =>
  new Response(JSON.stringify(corps), { status, headers: { 'Content-Type': 'application/json' } })

/**
 * Rend une cause d'erreur lisible.
 *
 * `String(cause)` produit « [object Object] » sur les erreurs PostgREST, qui
 * sont des objets simples et non des instances d'`Error` : le message réel
 * (colonne inconnue, politique refusée…) est alors totalement perdu.
 */
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
  if (requete.method !== 'POST') return reponse({ erreur: 'Méthode non autorisée.' }, 405)
  const attendu = Deno.env.get('FUNCTION_SECRET')
  if (!attendu) return reponse({ erreur: 'FUNCTION_SECRET non configuré.' }, 500)
  if (requete.headers.get('x-secret-notifications') !== attendu) return reponse({ erreur: 'Accès refusé.' }, 401)

  const { job_id } = await requete.json().catch(() => ({}))
  if (!Number.isSafeInteger(job_id) || job_id <= 0) return reponse({ erreur: 'job_id invalide.' }, 400)
  const supabase = createClient(Deno.env.get('SUPABASE_URL') ?? '', Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '')
  const { data: jobs, error: erreurPrise } = await supabase.rpc('prendre_notification', { p_id: job_id })
  if (erreurPrise) return reponse({ erreur: decrire(erreurPrise) }, 500)
  const job = (jobs as Job[] | null)?.[0]
  if (!job) return reponse({ statut: 'deja_traite_ou_en_cours' })
  let destinataire = ''
  let resultat: { statut: 'envoye' | 'simule' | 'echec'; erreur?: string }
  try {
    const urlApplication = (Deno.env.get('PUBLIC_APP_URL') ?? '').replace(/\/+$/, '')
    if (!/^https?:\/\//.test(urlApplication)) throw new Error('PUBLIC_APP_URL doit contenir l’adresse publique du site.')
    const { data: compte, error: erreurCompte } = await supabase.from('utilisateurs')
      .select('email').eq('notifications_email', true).eq('actif', true).maybeSingle()
    if (erreurCompte) throw erreurCompte
    if (!compte?.email) throw new Error('Aucun destinataire actif sélectionné dans Comptes.')
    destinataire = compte.email
    let message: { sujet: string; html: string; texte: string }
    if (job.mode === 'urgent') {
      const { data, error } = await supabase.from('tickets').select(SELECTION).eq('id', job.ticket_id).single()
      if (error) throw error
      const ticket = aplatir(data as unknown as LigneTicket)
      if (!ticket.risque_accident) throw new Error('Cet incident ne présente pas de risque signalé.')
      message = alerteUrgente(ticket, `${urlApplication}/incident/${ticket.id}`)
    } else {
      if (!job.debut || !job.fin) throw new Error('Période du récapitulatif absente.')
      const tickets: TicketCourriel[] = []
      // Pagination pour ne pas tronquer le récapitulatif à la limite REST.
      let offset = 0
      while (true) {
        const { data, error } = await supabase.from('tickets').select(SELECTION)
          .gte('created_at', job.debut).lt('created_at', job.fin)
          .order('created_at', { ascending: true }).order('id', { ascending: true })
          .range(offset, offset + 499)
        if (error) throw error
        const lignes = data as unknown as LigneTicket[]
        tickets.push(...lignes.map(aplatir))
        if (lignes.length < 500) break
        offset += lignes.length
      }
      const filtres = new URLSearchParams({
        du: new Date(job.debut).toISOString().slice(0, 10),
        au: new Date(job.fin).toISOString().slice(0, 10),
        statut: 'TOUS',
      })
      message = recapHebdomadaire(tickets, job.debut, job.fin, `${urlApplication}/suivi?${filtres}`)
    }
    resultat = await envoyer({ destinataires: [destinataire], ...message })
  } catch (cause) {
    resultat = { statut: 'echec', erreur: decrire(cause) }
  }
  const { error: erreurFin } = await supabase.rpc('terminer_notification', {
    p_id: job.id, p_verrou: job.verrou, p_statut: resultat.statut,
    p_erreur: resultat.erreur ?? null, p_destinataires: destinataire,
  })
  if (erreurFin) return reponse({ erreur: decrire(erreurFin) }, 500)
  return reponse({ job_id, ...resultat }, resultat.statut === 'echec' ? 503 : 200)
})
