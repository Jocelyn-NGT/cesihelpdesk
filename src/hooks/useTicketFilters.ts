import { useCallback, useMemo } from 'react'
import { useSearchParams } from 'react-router'
import type { Status, Ticket } from '../types/helpdesk'
import {
  FILTRES_VIDES,
  compterFiltresActifs,
  filtrerTickets,
  trierTickets,
  type ColonneTri,
  type FiltresTickets,
  type SensTri,
} from '../utils/ticketFilters'

/** Correspondance entre un critère et son paramètre d'URL. */
const PARAM = {
  titre: 'q',
  dateDebut: 'du',
  dateFin: 'au',
  salles: 'salle',
  types: 'type',
  statuts: 'statut',
  traitants: 'traitant',
  risque: 'risque',
  tri: 'tri',
  sens: 'sens',
} as const

/**
 * Gère les filtres du tableau de suivi, synchronisés avec la barre d'adresse.
 *
 * Les critères vivent dans la chaîne de requête plutôt que dans un état local :
 * une vue filtrée devient ainsi une URL que l'on peut transmettre à un collègue
 * ou mettre en favori, et le retour depuis la fiche d'un incident retrouve
 * exactement la liste que l'on avait sous les yeux.
 *
 * @param tickets Liste complète des tickets.
 * @returns Les critères courants, la liste filtrée et triée, et les actions.
 */
export const useTicketFilters = (tickets: Ticket[]) => {
  const [parametres, setParametres] = useSearchParams()

  const filtres = useMemo<FiltresTickets>(() => ({
    titre: parametres.get(PARAM.titre) ?? '',
    dateDebut: parametres.get(PARAM.dateDebut) ?? '',
    dateFin: parametres.get(PARAM.dateFin) ?? '',
    salles: parametres.getAll(PARAM.salles),
    types: parametres.getAll(PARAM.types),
    // Sans choix explicite, le suivi affiche uniquement les incidents ouverts.
    // « TOUS » distingue le choix volontaire de tous les statuts de l'absence
    // de filtre dans l'URL, y compris après rechargement ou retour d'une fiche.
    statuts: parametres.has(PARAM.statuts)
      ? parametres.getAll(PARAM.statuts).filter(statut => statut !== 'TOUS') as Status[]
      : ['NOUVEAU', 'EN_COURS', 'EN_ATTENTE'],
    traitants: parametres.getAll(PARAM.traitants),
    risque: parametres.get(PARAM.risque) === null ? null : parametres.get(PARAM.risque) === 'oui',
  }), [parametres])

  const colonneTri = (parametres.get(PARAM.tri) as ColonneTri | null) ?? 'date'
  const sensTri = (parametres.get(PARAM.sens) as SensTri | null) ?? 'desc'

  /** Remplace un critère et remet l'URL à jour. */
  const definir = useCallback(<C extends keyof FiltresTickets>(critere: C, valeur: FiltresTickets[C]) => {
    setParametres(actuels => {
      const suivants = new URLSearchParams(actuels)
      const cle = PARAM[critere]
      suivants.delete(cle)

      if (Array.isArray(valeur)) {
        valeur.forEach(element => suivants.append(cle, element))
        if (critere === 'statuts' && valeur.length === 0) suivants.set(cle, 'TOUS')
      } else if (critere === 'risque') {
        if (valeur !== null) suivants.set(cle, valeur ? 'oui' : 'non')
      } else if (valeur) {
        suivants.set(cle, String(valeur))
      }

      return suivants
    }, { replace: true })
  }, [setParametres])

  /** Change la colonne de tri, ou inverse le sens si c'est la même. */
  const trierPar = useCallback((colonne: ColonneTri) => {
    setParametres(actuels => {
      const suivants = new URLSearchParams(actuels)
      const colonneActuelle = suivants.get(PARAM.tri) ?? 'date'
      const sensActuel = suivants.get(PARAM.sens) ?? 'desc'
      const memeColonne = colonneActuelle === colonne
      suivants.set(PARAM.tri, colonne)
      suivants.set(PARAM.sens, memeColonne && sensActuel === 'desc' ? 'asc' : 'desc')
      return suivants
    }, { replace: true })
  }, [setParametres])

  /** Revient à la vue par défaut (incidents non terminés). */
  const reinitialiser = useCallback(() => {
    setParametres(actuels => {
      const suivants = new URLSearchParams(actuels)
      Object.values(PARAM).forEach(cle => suivants.delete(cle))
      return suivants
    }, { replace: true })
  }, [setParametres])

  const resultats = useMemo(
    () => trierTickets(filtrerTickets(tickets, filtres), colonneTri, sensTri),
    [tickets, filtres, colonneTri, sensTri],
  )

  return {
    filtres,
    filtresActifs: compterFiltresActifs(filtres),
    filtresVides: FILTRES_VIDES,
    colonneTri,
    sensTri,
    resultats,
    definir,
    trierPar,
    reinitialiser,
    /** Chaîne de requête courante, à transmettre à la fiche pour pouvoir revenir. */
    requete: parametres.toString(),
  }
}
