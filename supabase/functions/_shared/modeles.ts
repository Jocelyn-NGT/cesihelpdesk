/**
 * Gabarits des e-mails, aux couleurs du CESI.
 *
 * Les styles sont écrits en ligne : les clients de messagerie (Outlook en
 * particulier) ignorent les feuilles de style externes et une bonne partie des
 * balises `<style>`.
 */

const JAUNE = '#FBE800'
const NOIR = '#1A1A1A'

/** Ticket tel que lu en base pour la composition des e-mails. */
export interface TicketCourriel {
  id: number
  titre: string
  salle: string
  demandeur_nom: string
  demandeur_email: string
  description: string
  risque_accident: boolean
  created_at: string
  types: string[]
}

const dateFr = (iso: string): string =>
  new Date(iso).toLocaleString('fr-FR', {
    dateStyle: 'long',
    timeStyle: 'short',
    timeZone: 'Europe/Paris',
  })

/** Échappe le texte inséré dans le HTML (le titre est saisi par un visiteur anonyme). */
const echapper = (valeur: string): string =>
  valeur
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')

const enveloppe = (titre: string, contenu: string, accent: string): string => `
<div style="font-family:Helvetica,Arial,sans-serif;background:#F3F4F6;padding:24px;">
  <div style="max-width:600px;margin:0 auto;background:#fff;border:3px solid ${NOIR};border-radius:10px;overflow:hidden;">
    <div style="background:${accent};border-bottom:3px solid ${NOIR};padding:20px 24px;">
      <div style="font-weight:900;font-size:20px;color:${accent === JAUNE ? NOIR : '#fff'};">CESI HELP DESK</div>
      <div style="font-size:18px;font-weight:bold;margin-top:4px;color:${accent === JAUNE ? NOIR : '#fff'};">${echapper(titre)}</div>
    </div>
    <div style="padding:24px;color:${NOIR};font-size:14px;line-height:1.6;">
      ${contenu}
    </div>
    <div style="padding:14px 24px;background:#F3F4F6;border-top:1px solid #e5e7eb;font-size:11px;color:#6B7280;">
      Message automatique du portail de signalement des incidents du campus CESI.
      Ne pas répondre à cet e-mail.
    </div>
  </div>
</div>`

const ligne = (etiquette: string, valeur: string): string =>
  `<tr>
    <td style="padding:4px 12px 4px 0;color:#6B7280;white-space:nowrap;vertical-align:top;">${etiquette}</td>
    <td style="padding:4px 0;font-weight:bold;">${echapper(valeur)}</td>
  </tr>`

/**
 * Compose l'alerte envoyée immédiatement quand la case « Risque d'accident »
 * est cochée.
 *
 * @param ticket Incident concerné.
 * @param urlFiche Lien vers la fiche complète, ou chaîne vide.
 */
export const alerteUrgente = (ticket: TicketCourriel, urlFiche: string) => {
  const sujet = `[URGENT] Risque signalé — ${ticket.salle} — incident n° ${ticket.id}`

  const html = enveloppe(
    'Risque d\'accident ou de blessure',
    `
    <p style="margin:0 0 16px;">
      Un incident présentant un <strong>risque d'accident ou de blessure</strong>
      vient d'être signalé. Une vérification sur place est demandée.
    </p>
    <table style="border-collapse:collapse;width:100%;margin-bottom:16px;">
      ${ligne('Incident', `n° ${ticket.id}`)}
      ${ligne('Salle', ticket.salle)}
      ${ligne('Titre', ticket.titre)}
      ${ligne('Type(s)', ticket.types.join(', ') || 'Non précisé')}
      ${ligne('Déclaré le', dateFr(ticket.created_at))}
      ${ligne('Par', `${ticket.demandeur_nom} (${ticket.demandeur_email})`)}
    </table>
    <p style="margin:0 0 6px;color:#6B7280;">Description</p>
    <p style="margin:0 0 20px;padding:12px;background:#F3F4F6;border-radius:6px;white-space:pre-wrap;">${echapper(ticket.description)}</p>
    ${urlFiche ? `<a href="${echapper(urlFiche)}" style="display:inline-block;background:${NOIR};color:#fff;text-decoration:none;font-weight:bold;padding:12px 20px;border-radius:6px;">Ouvrir la fiche</a>` : ''}
    `,
    '#B91C1C',
  )

  const texte = [
    'RISQUE D\'ACCIDENT OU DE BLESSURE SIGNALÉ',
    '',
    `Incident   : n° ${ticket.id}`,
    `Salle      : ${ticket.salle}`,
    `Titre      : ${ticket.titre}`,
    `Type(s)    : ${ticket.types.join(', ') || 'Non précisé'}`,
    `Déclaré le : ${dateFr(ticket.created_at)}`,
    `Par        : ${ticket.demandeur_nom} (${ticket.demandeur_email})`,
    '',
    'Description :',
    ticket.description,
    '',
    urlFiche ? `Fiche : ${urlFiche}` : '',
  ].join('\n')

  return { sujet, html, texte }
}

/**
 * Compose le récapitulatif hebdomadaire des nouveaux incidents.
 *
 * @param tickets Incidents déclarés durant la période.
 * @param debut Début de la période (ISO).
 * @param fin Fin de la période (ISO).
 * @param urlSuivi Lien vers le tableau de suivi, ou chaîne vide.
 */
export const recapHebdomadaire = (
  tickets: TicketCourriel[],
  debut: string,
  fin: string,
  urlSuivi: string,
) => {
  const periode = `du ${dateFr(debut).split(' à ')[0]} au ${dateFr(fin).split(' à ')[0]}`
  const urgents = tickets.filter(t => t.risque_accident)
  const sujet = `Récapitulatif hebdomadaire — ${tickets.length} nouvel(le)(s) incident(s)`

  // Le cas « aucun incident » est traité explicitement : recevoir un tableau
  // vide sans explication laisse penser à une panne du service.
  const corps = tickets.length === 0
    ? `<p style="margin:0;">Aucun nouvel incident n'a été déclaré sur cette période.</p>${urlSuivi ? `<p><a href="${echapper(urlSuivi)}">Ouvrir le suivi des incidents</a></p>` : ''}`
    : `
      <p style="margin:0 0 16px;">
        <strong>${tickets.length}</strong> nouvel(le)(s) incident(s) déclaré(s) ${echapper(periode)},
        dont <strong style="color:#B91C1C;">${urgents.length}</strong> avec risque d'accident.
      </p>
      <table style="border-collapse:collapse;width:100%;font-size:13px;">
        <tr style="background:${JAUNE};">
          <th align="left" style="padding:8px;border-bottom:2px solid ${NOIR};">N°</th>
          <th align="left" style="padding:8px;border-bottom:2px solid ${NOIR};">Salle</th>
          <th align="left" style="padding:8px;border-bottom:2px solid ${NOIR};">Titre</th>
        </tr>
        ${tickets.map(t => `
        <tr${t.risque_accident ? ' style="background:#FEF2F2;"' : ''}>
          <td style="padding:8px;border-bottom:1px solid #e5e7eb;">${t.id}</td>
          <td style="padding:8px;border-bottom:1px solid #e5e7eb;">${echapper(t.salle)}</td>
          <td style="padding:8px;border-bottom:1px solid #e5e7eb;">
            ${echapper(t.titre)}${t.risque_accident ? ' <strong style="color:#B91C1C;">(risque)</strong>' : ''}
          </td>
        </tr>`).join('')}
      </table>
      ${urlSuivi ? `<p style="margin:20px 0 0;"><a href="${echapper(urlSuivi)}" style="display:inline-block;background:${NOIR};color:#fff;text-decoration:none;font-weight:bold;padding:12px 20px;border-radius:6px;">Ouvrir le suivi des incidents</a></p>` : ''}
    `

  const texte = tickets.length === 0
    ? `Aucun nouvel incident n'a été déclaré sur cette période (${periode}).\n${urlSuivi ? `Suivi : ${urlSuivi}` : ''}`
    : [
        `${tickets.length} nouvel(le)(s) incident(s) ${periode}, dont ${urgents.length} avec risque d'accident.`,
        '',
        ...tickets.map(t => `n° ${t.id} — ${t.salle} — ${t.titre}${t.risque_accident ? ' (RISQUE)' : ''}`),
        '',
        urlSuivi ? `Suivi : ${urlSuivi}` : '',
      ].join('\n')

  return { sujet, html: enveloppe('Récapitulatif hebdomadaire', corps, JAUNE), texte }
}
