import { useEffect, useMemo, useState } from 'react'
import { Link } from 'react-router'
import { MultiSelect } from '../../components/admin/MultiSelect/MultiSelect'
import { SuppressionIncident } from '../../components/admin/SuppressionIncident/SuppressionIncident'
import { Icons } from '../../components/ui/Icons/Icons'
import { STATUSES, STATUS_ORDER } from '../../data/helpdesk'
import { useTicketFilters } from '../../hooks/useTicketFilters'
import { useTickets } from '../../hooks/useTickets'
import { useToast } from '../../hooks/useToast'
import { utilisateurService } from '../../services/utilisateurs'
import type { Profil } from '../../types/auth'
import type { Status, Ticket } from '../../types/helpdesk'
import { valeursDistinctes, type ColonneTri } from '../../utils/ticketFilters'

const dateCourte = new Intl.DateTimeFormat('fr-FR', { day: '2-digit', month: '2-digit', year: 'numeric' })
const heureCourte = new Intl.DateTimeFormat('fr-FR', { hour: '2-digit', minute: '2-digit' })

/** En-tête de colonne cliquable pour le tri. */
const EnTeteTri = ({ colonne, libelle, colonneTri, sensTri, trierPar }: {
  colonne: ColonneTri
  libelle: string
  colonneTri: ColonneTri
  sensTri: 'asc' | 'desc'
  trierPar: (colonne: ColonneTri) => void
}) => {
  const actif = colonneTri === colonne
  return (
    <th scope="col" className="p-2 font-bold text-sm text-left">
      <button
        type="button"
        onClick={() => trierPar(colonne)}
        aria-sort={actif ? (sensTri === 'asc' ? 'ascending' : 'descending') : 'none'}
        className="flex items-center gap-1 hover:underline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-black rounded"
      >
        {libelle}
        <span aria-hidden="true" className={actif ? 'text-xs' : 'text-xs text-gray-300'}>
          {actif && sensTri === 'asc' ? '↑' : '↓'}
        </span>
      </button>
    </th>
  )
}

/** Tableau de suivi des incidents, avec un filtre par colonne. */
export const IncidentListPage = () => {
  const { tickets, chargement, modifier, supprimer } = useTickets()
  const toast = useToast()
  const [exportEnCours, setExportEnCours] = useState(false)
  const [pdfEnCours, setPdfEnCours] = useState(false)
  const [selection, setSelection] = useState<string[]>([])
  const [aSupprimer, setASupprimer] = useState<Ticket | null>(null)
  const [suppressionEnCours, setSuppressionEnCours] = useState(false)
  const [equipe, setEquipe] = useState<Profil[]>([])
  const [affectationsEnCours, setAffectationsEnCours] = useState<string[]>([])
  const {
    filtres, filtresActifs, colonneTri, sensTri, resultats,
    definir, trierPar, reinitialiser, requete,
  } = useTicketFilters(tickets)

  // Les valeurs proposées viennent des tickets réellement présents : proposer
  // une salle qui n'a jamais eu d'incident n'aiderait personne.
  const sallesDisponibles = useMemo(() => valeursDistinctes(tickets, t => [t.room]), [tickets])
  const typesDisponibles = useMemo(() => valeursDistinctes(tickets, t => t.types), [tickets])
  const traitantsDisponibles = useMemo(() => valeursDistinctes(tickets, t => [t.handler]), [tickets])
  const idsSelectionnes = useMemo(() => new Set(selection), [selection])
  const selectionnes = useMemo(() => tickets.filter(ticket => idsSelectionnes.has(ticket.id)), [tickets, idsSelectionnes])
  const tousVisiblesSelectionnes = resultats.length > 0 && resultats.every(ticket => idsSelectionnes.has(ticket.id))

  const selectionnerVisibles = () => {
    const visibles = new Set(resultats.map(ticket => ticket.id))
    setSelection(ids => tousVisiblesSelectionnes
      ? ids.filter(id => !visibles.has(id))
      : [...new Set([...ids, ...visibles])])
  }

  const exporterPdf = async () => {
    setPdfEnCours(true)
    try {
      const { exporterIncidentsPdf } = await import('../../services/pdfExport')
      await exporterIncidentsPdf(selectionnes)
      toast.succes(`${selectionnes.length} incident(s) exporté(s) en PDF.`)
    } catch (cause) {
      toast.erreurDe(cause, "L'export PDF a échoué.")
    } finally {
      setPdfEnCours(false)
    }
  }

  useEffect(() => {
    let monte = true
    utilisateurService.listActifs()
      .then(membres => { if (monte) setEquipe(membres) })
      .catch(cause => { if (monte) toast.erreurDe(cause, 'Impossible de charger les traitants.') })
    return () => { monte = false }
  }, [toast])

  const affecter = async (ticketId: string, traitantId: string) => {
    setAffectationsEnCours(ids => [...ids, ticketId])
    try {
      await modifier(ticketId, 'handler', traitantId)
    } finally {
      setAffectationsEnCours(ids => ids.filter(id => id !== ticketId))
    }
  }

  const exporter = async () => {
    setExportEnCours(true)
    try {
      const { exporterVersExcel } = await import('../../services/excelExport')
      await exporterVersExcel(resultats)
      toast.succes(`${resultats.length} incident(s) exporté(s) au format Excel.`)
    } catch (cause) {
      toast.erreurDe(cause, "L'export Excel a échoué.")
    } finally {
      setExportEnCours(false)
    }
  }

  const confirmerSuppression = async () => {
    if (!aSupprimer) return
    setSuppressionEnCours(true)
    try {
      await supprimer(aSupprimer)
    } catch {
      // Le contexte a déjà notifié le refus et remis la ligne dans le tableau.
    } finally {
      setSuppressionEnCours(false)
      setASupprimer(null)
    }
  }

  return (
    <div className="bg-white rounded-xl shadow p-4 sm:p-6">
      <div className="flex flex-col lg:flex-row justify-between lg:items-center mb-4 gap-3">
        <div>
          <h1 className="text-2xl font-black uppercase tracking-tight">Suivi des incidents</h1>
          <p className="text-sm text-gray-600 mt-1">
            {chargement
              ? 'Chargement…'
              : `${resultats.length} incident(s) affiché(s) sur ${tickets.length}`}
            {filtresActifs > 0 && (
              <span className="ml-2 inline-flex items-center gap-1 bg-cesi-jaune border border-black rounded-full px-2 py-0.5 text-xs font-bold">
                <Icons.Filter /> {filtresActifs} filtre(s)
              </span>
            )}
          </p>
        </div>

        <div className="flex flex-wrap gap-2 items-center">
          <button
            type="button"
            onClick={() => void exporterPdf()}
            disabled={pdfEnCours || selectionnes.length === 0}
            className="flex items-center gap-2 bg-gray-800 hover:bg-black disabled:opacity-50 text-white px-4 py-2 min-h-11 rounded text-sm font-bold transition-colors"
          >
            {pdfEnCours ? 'Création du PDF…' : `Télécharger PDF (${selectionnes.length})`}
          </button>
          {filtresActifs > 0 && (
            <button
              type="button"
              onClick={reinitialiser}
              className="text-sm border-2 border-black px-3 py-2 min-h-11 rounded font-bold hover:bg-gray-100 transition-colors"
            >
              Réinitialiser les filtres
            </button>
          )}
          <button
            type="button"
            onClick={exporter}
            disabled={exportEnCours || resultats.length === 0}
            className="flex items-center gap-2 bg-green-700 hover:bg-green-800 disabled:opacity-50 text-white px-4 py-2 min-h-11 rounded text-sm font-bold transition-colors"
          >
            <Icons.Download /> {exportEnCours ? 'Export…' : 'Exporter (.xlsx)'}
          </button>
        </div>
      </div>

      <div className="overflow-x-auto">
        <table className="w-full text-left border-collapse min-w-4xl">
          <caption className="sr-only">
            Liste des incidents déclarés, filtrable et triable par colonne.
          </caption>
          <thead>
            <tr className="border-b-2 border-black bg-gray-50">
              <th scope="col" className="p-2 text-center">
                <input type="checkbox" aria-label="Sélectionner tous les incidents affichés" checked={tousVisiblesSelectionnes} onChange={selectionnerVisibles} disabled={resultats.length === 0} className="w-4 h-4 accent-black cursor-pointer" />
              </th>
              <EnTeteTri colonne="date" libelle="Date" colonneTri={colonneTri} sensTri={sensTri} trierPar={trierPar} />
              <EnTeteTri colonne="title" libelle="Titre" colonneTri={colonneTri} sensTri={sensTri} trierPar={trierPar} />
              <EnTeteTri colonne="room" libelle="Lieu" colonneTri={colonneTri} sensTri={sensTri} trierPar={trierPar} />
              <th scope="col" className="p-2 font-bold text-sm">Type</th>
              <EnTeteTri colonne="status" libelle="Statut" colonneTri={colonneTri} sensTri={sensTri} trierPar={trierPar} />
              <EnTeteTri colonne="handler" libelle="Traitant" colonneTri={colonneTri} sensTri={sensTri} trierPar={trierPar} />
              <th scope="col" className="p-2 font-bold text-sm">Risque</th>
              <th scope="col" className="p-2 font-bold text-sm text-center">Actions</th>
            </tr>

            {/* Ligne de filtres : un contrôle par colonne, comme demandé au
                cahier des charges. Les valeurs sont reportées dans l'URL. */}
            <tr className="border-b-2 border-gray-200 bg-gray-50 align-top">
              <td />
              <td className="p-2">
                <div className="flex flex-col gap-1">
                  <input
                    type="date"
                    aria-label="Date de début"
                    value={filtres.dateDebut}
                    onChange={e => definir('dateDebut', e.target.value)}
                    className="text-xs border border-gray-300 rounded px-1 py-1.5 min-h-9 w-36"
                  />
                  <input
                    type="date"
                    aria-label="Date de fin"
                    value={filtres.dateFin}
                    onChange={e => definir('dateFin', e.target.value)}
                    className="text-xs border border-gray-300 rounded px-1 py-1.5 min-h-9 w-36"
                  />
                </div>
              </td>
              <td className="p-2">
                <input
                  type="search"
                  aria-label="Rechercher dans le titre, la description ou le demandeur"
                  placeholder="Rechercher…"
                  value={filtres.titre}
                  onChange={e => definir('titre', e.target.value)}
                  className="text-xs border border-gray-300 rounded px-2 py-1.5 min-h-9 w-full min-w-40"
                />
              </td>
              <td className="p-2 min-w-32">
                <MultiSelect label="lieu" options={sallesDisponibles} valeurs={filtres.salles} onChange={v => definir('salles', v)} />
              </td>
              <td className="p-2 min-w-32">
                <MultiSelect label="type d'incident" options={typesDisponibles} valeurs={filtres.types} onChange={v => definir('types', v)} />
              </td>
              <td className="p-2 min-w-32">
                <MultiSelect
                  label="statut"
                  options={STATUS_ORDER}
                  valeurs={filtres.statuts}
                  onChange={v => definir('statuts', v as Status[])}
                />
              </td>
              <td className="p-2 min-w-32">
                <MultiSelect label="traitant" options={traitantsDisponibles} valeurs={filtres.traitants} onChange={v => definir('traitants', v)} libelleVide="Non assigné" />
              </td>
              <td className="p-2">
                <select
                  aria-label="Filtrer par risque"
                  value={filtres.risque === null ? '' : filtres.risque ? 'oui' : 'non'}
                  onChange={e => definir('risque', e.target.value === '' ? null : e.target.value === 'oui')}
                  className="text-xs border border-gray-300 rounded px-1 py-1.5 min-h-9 bg-white w-full"
                >
                  <option value="">Tous</option>
                  <option value="oui">Oui</option>
                  <option value="non">Non</option>
                </select>
              </td>
              <td />
            </tr>
          </thead>

          <tbody>
            {resultats.map(ticket => (
              <tr
                key={ticket.id}
                className={`border-b transition-colors ${ticket.risk ? 'bg-red-50 hover:bg-red-100' : 'hover:bg-gray-50'}`}
              >
                <td className="p-2 text-center">
                  <input
                    type="checkbox"
                    aria-label={`Sélectionner l'incident n° ${ticket.id}`}
                    checked={idsSelectionnes.has(ticket.id)}
                    onChange={() => setSelection(ids => ids.includes(ticket.id) ? ids.filter(id => id !== ticket.id) : [...ids, ticket.id])}
                    className="w-4 h-4 accent-black cursor-pointer"
                  />
                </td>
                <td className="p-2 whitespace-nowrap">
                  <div className="text-sm">{dateCourte.format(new Date(ticket.createdAt))}</div>
                  <div className="text-xs text-gray-500">{heureCourte.format(new Date(ticket.createdAt))}</div>
                </td>
                <td className="p-2">
                  <Link
                    to={{ pathname: `/incident/${ticket.id}`, search: requete ? `?retour=${encodeURIComponent(requete)}` : '' }}
                    className="font-bold hover:underline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-black rounded"
                  >
                    {ticket.title}
                  </Link>
                  <div className="text-xs text-gray-500">n° {ticket.id} — {ticket.name}</div>
                </td>
                <td className="p-2 text-sm text-gray-700">{ticket.room}</td>
                <td className="p-2 text-xs text-gray-600 max-w-40">{ticket.types.join(', ') || '—'}</td>
                <td className="p-2">
                  <select
                    aria-label={`Statut de l'incident n° ${ticket.id}`}
                    className={`text-xs font-bold px-2 py-2 min-h-9 rounded-full outline-none border cursor-pointer ${STATUSES[ticket.status].color}`}
                    value={ticket.status}
                    onChange={e => void modifier(ticket.id, 'status', e.target.value)}
                  >
                    {STATUS_ORDER.map(cle => (
                      <option key={cle} value={cle}>{STATUSES[cle].label}</option>
                    ))}
                  </select>
                </td>
                <td className="p-2 text-sm">
                  <select
                    aria-label={`Traitant de l'incident n° ${ticket.id}`}
                    value={ticket.handlerId ?? ''}
                    onChange={e => void affecter(ticket.id, e.target.value)}
                    disabled={affectationsEnCours.includes(ticket.id)}
                    className="w-full min-w-36 max-w-52 border border-gray-300 rounded bg-white px-2 py-2 min-h-9 text-sm disabled:opacity-50 focus-visible:outline-2 focus-visible:outline-black"
                  >
                    <option value="">Non assigné</option>
                    {ticket.handlerId && !equipe.some(membre => membre.id === ticket.handlerId) && (
                      <option value={ticket.handlerId}>{ticket.handler || 'Compte désactivé'}</option>
                    )}
                    {equipe.map(membre => (
                      <option key={membre.id} value={membre.id}>{membre.nomComplet}</option>
                    ))}
                  </select>
                </td>
                <td className="p-2 text-center">
                  {ticket.risk
                    ? <span className="text-red-700 inline-flex" title="Risque d'accident signalé"><Icons.Alert /></span>
                    : <span className="text-gray-300">—</span>}
                </td>
                <td className="p-2">
                  <div className="flex items-center justify-center">
                    <Link
                      to={{ pathname: `/incident/${ticket.id}`, search: requete ? `?retour=${encodeURIComponent(requete)}` : '' }}
                      title="Ouvrir la fiche complète"
                      className="inline-flex items-center justify-center w-11 h-11 text-gray-500 hover:text-black hover:bg-gray-100 rounded transition-colors"
                    >
                      <Icons.Eye />
                      <span className="sr-only">Fiche de l'incident n° {ticket.id}</span>
                    </Link>
                    {/* Ouvert à tout le personnel, techniciens compris : ce sont
                        eux qui voient passer les doublons et les essais. La base
                        applique la même règle (`tickets_suppression_personnel`). */}
                    <button
                      type="button"
                      onClick={() => setASupprimer(ticket)}
                      title="Supprimer l'incident"
                      className="inline-flex items-center justify-center w-11 h-11 text-gray-500 hover:text-red-700 hover:bg-red-50 rounded transition-colors"
                    >
                      <Icons.Trash />
                      <span className="sr-only">Supprimer l'incident n° {ticket.id}</span>
                    </button>
                  </div>
                </td>
              </tr>
            ))}

            {!chargement && resultats.length === 0 && (
              <tr>
                <td colSpan={9} className="p-8 text-center text-gray-500">
                  {tickets.length === 0
                    ? 'Aucun incident déclaré pour le moment.'
                    : 'Aucun incident ne correspond aux filtres sélectionnés.'}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      <SuppressionIncident
        ticket={aSupprimer}
        occupe={suppressionEnCours}
        onConfirmer={() => void confirmerSuppression()}
        onAnnuler={() => setASupprimer(null)}
      />
    </div>
  )
}
