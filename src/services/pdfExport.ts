/** Export des incidents sélectionnés : une fiche A4 par incident. */
import fontkit from '@pdf-lib/fontkit'
import { PDFDocument, rgb, type PDFFont, type PDFPage } from 'pdf-lib'
import policeUrl from '../assets/DejaVuSans.ttf?url'
import policeGrasseUrl from '../assets/DejaVuSans-Bold.ttf?url'
import { STATUSES } from '../data/helpdesk'
import { supabase } from '../lib/supabase'
import type { Ticket } from '../types/helpdesk'
import { BUCKET_INCIDENTS } from './storage'

const LARGEUR = 595.28
const HAUTEUR = 841.89
const MARGE = 42
const LARGEUR_TEXTE = LARGEUR - MARGE * 2
const noir = rgb(0.08, 0.08, 0.08)
const gris = rgb(0.34, 0.37, 0.4)
const jaune = rgb(0.98, 0.91, 0)
const date = new Intl.DateTimeFormat('fr-FR', { dateStyle: 'long', timeStyle: 'short' })

type Bloc = { titre: string; texte: string }

/** Coupe aux limites de la police plutôt qu'au nombre de caractères. */
const lignes = (texte: string, police: PDFFont, taille: number): string[] => {
  const resultat: string[] = []
  for (const paragraphe of texte.replace(/\r\n?/g, '\n').split('\n')) {
    let ligne = ''
    for (const mot of paragraphe.split(/\s+/).filter(Boolean)) {
      const essai = ligne ? `${ligne} ${mot}` : mot
      if (police.widthOfTextAtSize(essai, taille) <= LARGEUR_TEXTE) { ligne = essai; continue }
      if (ligne) resultat.push(ligne)
      ligne = ''
      // Un mot ou une URL peut être plus long que toute la largeur utile.
      for (const caractere of mot) {
        if (police.widthOfTextAtSize(ligne + caractere, taille) > LARGEUR_TEXTE && ligne) {
          resultat.push(ligne)
          ligne = ''
        }
        ligne += caractere
      }
    }
    resultat.push(ligne)
  }
  return resultat
}

const blocs = (ticket: Ticket): Bloc[] => [
  { titre: 'Demandeur', texte: `${ticket.name} - ${ticket.email}` },
  { titre: 'Déclaré le', texte: date.format(new Date(ticket.createdAt)) },
  { titre: 'Lieu', texte: ticket.room || 'Non précisé' },
  { titre: "Type d'incident", texte: ticket.types.join(', ') || 'Non précisé' },
  { titre: 'Statut', texte: STATUSES[ticket.status].label },
  { titre: 'Traitant', texte: ticket.handler || 'Non assigné' },
  { titre: "Risque d'accident", texte: ticket.risk ? 'Oui' : 'Non' },
  { titre: 'Description', texte: ticket.comment || 'Aucune description' },
  { titre: 'Commentaire de suivi', texte: ticket.adminComment || 'Aucun commentaire' },
  ...(ticket.resolvedAt ? [{ titre: 'Résolu le', texte: date.format(new Date(ticket.resolvedAt)) }] : []),
  ...(!ticket.photoPath && ticket.photoDeletedAt ? [{ titre: 'Photo', texte: `Supprimée le ${date.format(new Date(ticket.photoDeletedAt))}` }] : []),
]

const tracerFiche = (
  page: PDFPage, ticket: Ticket, numero: number, total: number,
  police: PDFFont, gras: PDFFont, photo: { bytes: Uint8Array; format: 'jpg' | 'png' } | null,
  document: PDFDocument,
) => {
  page.drawRectangle({ x: 0, y: HAUTEUR - 86, width: LARGEUR, height: 86, color: jaune })
  page.drawText('CESI  |  HELP DESK', { x: MARGE, y: HAUTEUR - 35, size: 12, font: gras, color: noir })
  page.drawText(`INCIDENT N° ${ticket.id}`, { x: MARGE, y: HAUTEUR - 67, size: 18, font: gras, color: noir })

  const corps = blocs(ticket)
  const titre = lignes(ticket.title, gras, 14)
  let taille = 10
  const reservePhoto = photo ? 150 : 0
  const hauteurDisponible = HAUTEUR - 172 - reservePhoto
  const hauteurBlocs = (s: number) => corps.reduce((h, bloc) =>
    h + 12 + lignes(bloc.texte, police, s).length * (s * 1.35) + 7, 0)
  while (taille > 6 && hauteurBlocs(taille) + titre.length * 19 > hauteurDisponible) taille -= 0.5
  if (hauteurBlocs(taille) + titre.length * 19 > hauteurDisponible) {
    throw new Error(`L'incident n° ${ticket.id} contient trop de texte pour tenir sur une page A4.`)
  }

  let y = HAUTEUR - 109
  for (const ligne of titre) {
    page.drawText(ligne, { x: MARGE, y, size: 14, font: gras, color: noir })
    y -= 19
  }
  y -= 9
  for (const bloc of corps) {
    page.drawText(bloc.titre.toUpperCase(), { x: MARGE, y, size: 8, font: gras, color: gris })
    y -= 12
    for (const ligne of lignes(bloc.texte, police, taille)) {
      if (ligne) page.drawText(ligne, { x: MARGE, y, size: taille, font: police, color: noir })
      y -= taille * 1.35
    }
    y -= 7
  }

  if (photo) {
    const image = photo.format === 'png' ? document.embedPng(photo.bytes) : document.embedJpg(photo.bytes)
    // Les images embarquées sont déjà disponibles après résolution ci-dessous.
    return image.then(img => {
      const facteur = Math.min(LARGEUR_TEXTE / img.width, 125 / img.height, 1)
      const hauteur = img.height * facteur
      page.drawText('PHOTO JOINTE', { x: MARGE, y: y - 2, size: 8, font: gras, color: gris })
      page.drawImage(img, { x: MARGE, y: y - 12 - hauteur, width: img.width * facteur, height: hauteur })
      piedDePage(page, numero, total, police)
    })
  }
  piedDePage(page, numero, total, police)
  return Promise.resolve()
}

const piedDePage = (page: PDFPage, numero: number, total: number, police: PDFFont) => {
  page.drawLine({ start: { x: MARGE, y: 40 }, end: { x: LARGEUR - MARGE, y: 40 }, thickness: 0.5, color: gris })
  page.drawText(`CESI - Suivi des incidents     ${numero} / ${total}`, { x: MARGE, y: 25, size: 8, font: police, color: gris })
}

const chargerPhoto = async (chemin: string | null) => {
  if (!chemin) return null
  const { data, error } = await supabase.storage.from(BUCKET_INCIDENTS).download(chemin)
  if (error || !data) throw new Error(`Impossible de récupérer la photo jointe (${chemin}).`)
  const format = data.type === 'image/png' || chemin.toLowerCase().endsWith('.png') ? 'png' : 'jpg'
  return { bytes: new Uint8Array(await data.arrayBuffer()), format } as const
}

export const exporterIncidentsPdf = async (tickets: Ticket[]): Promise<void> => {
  if (!tickets.length) return
  const document = await PDFDocument.create()
  document.registerFontkit(fontkit)
  const [normale, grasse] = await Promise.all([
    fetch(policeUrl).then(reponse => reponse.arrayBuffer()),
    fetch(policeGrasseUrl).then(reponse => reponse.arrayBuffer()),
  ])
  const police = await document.embedFont(normale, { subset: true })
  const gras = await document.embedFont(grasse, { subset: true })
  for (const [index, ticket] of tickets.entries()) {
    const photo = await chargerPhoto(ticket.photoPath)
    const page = document.addPage([LARGEUR, HAUTEUR])
    await tracerFiche(page, ticket, index + 1, tickets.length, police, gras, photo, document)
  }
  const bytes = await document.save()
  const url = URL.createObjectURL(new Blob([new Uint8Array(bytes)], { type: 'application/pdf' }))
  const lien = window.document.createElement('a')
  lien.href = url
  lien.download = `CESI_Incidents_selection_${new Date().toISOString().slice(0, 10)}.pdf`
  window.document.body.append(lien)
  lien.click()
  lien.remove()
  setTimeout(() => URL.revokeObjectURL(url), 60_000)
}
