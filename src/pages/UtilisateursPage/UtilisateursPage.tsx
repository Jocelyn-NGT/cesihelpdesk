import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent, type KeyboardEvent } from 'react'
import { ConfirmDialog } from '../../components/ui/ConfirmDialog/ConfirmDialog'
import { Icons } from '../../components/ui/Icons/Icons'
import { useAuth } from '../../hooks/useAuth'
import { useTickets } from '../../hooks/useTickets'
import { useToast } from '../../hooks/useToast'
import { utilisateurService } from '../../services/utilisateurs'
import type { InvitationInput, Profil, Role } from '../../types/auth'
import { normaliser } from '../../utils/ticketFilters'

const SAISIE_VIDE: InvitationInput = { nomComplet: '', email: '', role: 'technicien' }

const classesChamp = (enErreur = false) =>
  `w-full border-2 rounded p-2 min-h-11 outline-none transition-colors ${
    enErreur ? 'border-red-500 bg-red-50' : 'border-gray-200 focus:border-black'
  }`
const classesBoutonPrincipal = 'flex items-center justify-center gap-2 bg-black text-white px-4 py-2 min-h-11 rounded text-sm font-bold hover:bg-gray-800 disabled:opacity-50 transition-colors'
const classesBoutonSecondaire = 'flex items-center gap-2 border-2 border-black px-3 py-2 min-h-11 rounded text-sm font-bold hover:bg-gray-100 disabled:opacity-50 transition-colors'
const classesSelect = 'border-2 border-gray-200 rounded px-2 py-2 min-h-11 text-sm font-bold bg-white focus:border-black outline-none disabled:opacity-50 disabled:bg-gray-100 transition-colors'

/** Compte en cours de renommage, avec la saisie en cours. */
type Edition = { id: string; nomComplet: string }

/** Lien fraîchement produit, en attente d'être transmis par l'administrateur. */
type LienProduit = {
  /** `invitation` ou `mot de passe` : ce que la personne trouvera au bout. */
  nature: 'invitation' | 'mot-de-passe'
  /** Compte concerné, pour éviter de transmettre le lien à la mauvaise personne. */
  email: string
  url: string
}

/**
 * Affiche le lien produit, avec de quoi le copier.
 *
 * Il ne part par aucun e-mail : cette instance n'a pas de relais SMTP pour
 * Supabase Auth. C'est donc le seul endroit et le seul moment où le lien est
 * visible — d'où l'avertissement, et le défilement automatique jusqu'ici quand
 * l'action a été déclenchée depuis une ligne du tableau, plus bas.
 */
const BoiteLien = ({ lien, onFermer }: { lien: LienProduit; onFermer: () => void }) => {
  const toast = useToast()
  const boite = useRef<HTMLElement>(null)

  useEffect(() => {
    boite.current?.scrollIntoView({ block: 'center', behavior: 'smooth' })
  }, [])

  const copier = async () => {
    try {
      await navigator.clipboard.writeText(lien.url)
      toast.succes('Lien copié.')
    } catch {
      // Le presse-papiers est refusé hors contexte sécurisé (http). Le lien
      // reste sélectionnable à la main dans le champ ci-dessus.
      toast.erreur('Copie impossible depuis ce navigateur : sélectionnez le lien pour le copier.')
    }
  }

  return (
    <section
      ref={boite}
      aria-labelledby="lien-titre"
      className="bg-white border-4 border-black shadow-[8px_8px_0px_0px_rgba(0,0,0,1)] rounded-xl p-6"
      role="status"
      aria-live="polite"
    >
      <div className="flex items-start justify-between gap-3 mb-3">
        <div>
          <h2 id="lien-titre" className="text-lg font-black uppercase tracking-tight">
            {lien.nature === 'invitation' ? 'Lien d’invitation' : 'Lien de mot de passe'}
          </h2>
          <p className="text-sm text-gray-600 mt-1">
            À transmettre à <strong className="break-all">{lien.email}</strong>, par le moyen de votre choix.
          </p>
        </div>
        <button type="button" onClick={onFermer} aria-label="Masquer le lien" className={classesBoutonSecondaire}>
          <Icons.Close /> Masquer
        </button>
      </div>

      <label htmlFor="lien-produit" className="sr-only">Lien à transmettre</label>
      <div className="flex flex-col sm:flex-row gap-2">
        <input
          id="lien-produit"
          type="text"
          readOnly
          value={lien.url}
          onFocus={evenement => evenement.currentTarget.select()}
          className="w-full border-2 border-gray-200 rounded p-2 min-h-11 text-sm font-mono bg-gray-50 focus:border-black outline-none"
        />
        <button type="button" onClick={() => void copier()} className={classesBoutonPrincipal}>
          <Icons.Check /> Copier
        </button>
      </div>

      <p className="text-xs text-gray-500 mt-3">
        Ce lien ouvre l'écran « Votre mot de passe ». Il ne sert qu'une fois et finit par expirer :
        s'il n'aboutit plus, produisez-en un nouveau. <strong>Il ne sera plus affiché après fermeture
        de cette page</strong> — copiez-le maintenant.
      </p>
    </section>
  )
}

const Etat = ({ actif }: { actif: boolean }) => actif
  ? <span className="inline-block text-xs font-bold px-2 py-1 rounded-full bg-green-100 text-green-800 border border-green-300">Actif</span>
  : <span className="inline-block text-xs font-bold px-2 py-1 rounded-full bg-gray-200 text-gray-700 border border-gray-300">Désactivé</span>

const EtiquetteRole = ({ role }: { role: Role }) => role === 'admin'
  ? <span className="inline-block text-xs font-bold px-2 py-1 rounded-full bg-cesi-jaune text-black border border-black">Administrateur</span>
  : <span className="inline-block text-xs font-bold px-2 py-1 rounded-full bg-gray-100 text-gray-800 border border-gray-300">Technicien</span>

/** Ligne du tableau en mode renommage : seul le nom devient saisissable. */
const LigneEdition = ({ compte, edition, erreur, occupe, onChange, onEnregistrer, onAnnuler }: {
  compte: Profil
  edition: Edition
  erreur: string | null
  occupe: boolean
  onChange: (edition: Edition) => void
  onEnregistrer: () => void
  onAnnuler: () => void
}) => {
  // Pas de <form> possible dans une ligne de tableau : Entrée et Échap sont
  // gérés à la main pour retrouver le comportement attendu d'un formulaire.
  const surTouche = (evenement: KeyboardEvent<HTMLInputElement>) => {
    if (evenement.key === 'Enter') { evenement.preventDefault(); onEnregistrer() }
    if (evenement.key === 'Escape') onAnnuler()
  }

  return (
    <tr className="border-b bg-cesi-jaune/10 align-top">
      <td className="p-2">
        <label htmlFor={`edition-nom-${compte.id}`} className="sr-only">
          Nouveau nom affiché de {compte.nomComplet}
        </label>
        <input
          id={`edition-nom-${compte.id}`}
          type="text"
          autoFocus
          value={edition.nomComplet}
          onChange={e => onChange({ ...edition, nomComplet: e.target.value })}
          onKeyDown={surTouche}
          aria-invalid={Boolean(erreur)}
          aria-describedby={erreur ? `erreur-edition-${compte.id}` : undefined}
          className={classesChamp(Boolean(erreur))}
        />
        {erreur && (
          <p id={`erreur-edition-${compte.id}`} role="alert" className="mt-1 text-sm text-red-700 font-medium">{erreur}</p>
        )}
      </td>
      <td className="p-2 pt-4 text-sm text-gray-600 break-all">{compte.email}</td>
      <td className="p-2 pt-4"><EtiquetteRole role={compte.role} /></td>
      <td className="p-2 pt-4"><Etat actif={compte.actif} /></td>
      <td className="p-2 pt-4 text-sm">{compte.notificationsEmail ? 'Destinataire' : '—'}</td>
      <td className="p-2">
        <div className="flex justify-end gap-2">
          <button type="button" onClick={onEnregistrer} disabled={occupe} className={classesBoutonPrincipal}>
            <Icons.Check /> {occupe ? 'Enregistrement…' : 'Enregistrer'}
          </button>
          <button type="button" onClick={onAnnuler} disabled={occupe} className={classesBoutonSecondaire}>
            Annuler
          </button>
        </div>
      </td>
    </tr>
  )
}

/**
 * Gestion des comptes du personnel.
 *
 * Inviter quelqu'un, corriger un nom affiché, changer un rôle, activer ou
 * désactiver, sélectionner le destinataire des notifications et supprimer
 * définitivement un compte avec confirmation et désassignation des incidents.
 *
 * L'invitation et la réinitialisation de mot de passe produisent un LIEN, que
 * l'administrateur transmet lui-même : Supabase Auth n'a pas de relais SMTP sur
 * cette instance. Ces deux actions passent par la fonction Edge « comptes »,
 * seule à détenir la clé de service ; les autres écrivent directement dans la
 * table, sous le contrôle des politiques RLS.
 *
 * Toutes se faisaient jusqu'ici en SQL ou en SSH sur la VM
 * (docs/04-exploitation.md) — hors de portée d'un administrateur qui n'a que
 * l'application sous la main.
 */
export const UtilisateursPage = () => {
  const toast = useToast()
  const { profil } = useAuth()
  const { recharger: rechargerTickets } = useTickets()
  const [comptes, setComptes] = useState<Profil[]>([])
  const [chargement, setChargement] = useState(true)
  const [recherche, setRecherche] = useState('')
  const [edition, setEdition] = useState<Edition | null>(null)
  const [erreurEdition, setErreurEdition] = useState<string | null>(null)
  /** Compte en cours d'écriture : bloque les autres actions pendant ce temps. */
  const [occupe, setOccupe] = useState<string | null>(null)
  const [invitation, setInvitation] = useState<InvitationInput>(SAISIE_VIDE)
  const [erreurInvitation, setErreurInvitation] = useState<string | null>(null)
  const [envoiInvitation, setEnvoiInvitation] = useState(false)
  const [lien, setLien] = useState<LienProduit | null>(null)
  const [aSupprimer, setASupprimer] = useState<Profil | null>(null)

  // Programmation globale du récapitulatif hebdomadaire.
  // ISO : lundi=1 ... dimanche=7.
  const [jourNotifications, setJourNotifications] = useState(5)
  const [heureNotifications, setHeureNotifications] = useState('08:00')
  const [chargementNotifications, setChargementNotifications] = useState(true)
  const [enregistrementNotifications, setEnregistrementNotifications] = useState(false)

  const charger = useCallback(
    () => utilisateurService.listerTous()
      .then(setComptes)
      .catch((cause: unknown) => toast.erreurDe(cause, 'Impossible de charger la liste des comptes.'))
      .finally(() => setChargement(false)),
    [toast],
  )

  useEffect(() => { void charger() }, [charger])

  useEffect(() => {
    let actif = true

    utilisateurService.lireConfigurationNotifications()
      .then(configuration => {
        if (!actif) return
        setJourNotifications(configuration.jour)
        setHeureNotifications(configuration.heure)
      })
      .catch((cause: unknown) => {
        if (actif) {
          toast.erreurDe(cause, 'Impossible de charger la programmation des notifications.')
        }
      })
      .finally(() => {
        if (actif) setChargementNotifications(false)
      })

    return () => { actif = false }
  }, [toast])

  const enregistrerConfigurationNotifications = async () => {
    setEnregistrementNotifications(true)

    try {
      await utilisateurService.modifierConfigurationNotifications(
        jourNotifications,
        heureNotifications,
      )
      toast.succes('Programmation du récapitulatif enregistrée.')
    } catch (cause) {
      toast.erreurDe(cause, 'Impossible d’enregistrer la programmation.')
    } finally {
      setEnregistrementNotifications(false)
    }
  }

  const resultats = useMemo(() => {
    const critere = normaliser(recherche)
    if (!critere) return comptes
    return comptes.filter(c => normaliser(c.nomComplet).includes(critere) || normaliser(c.email).includes(critere))
  }, [comptes, recherche])

  const nbAdmins = comptes.filter(c => c.role === 'admin' && c.actif).length
  const nbInactifs = comptes.filter(c => !c.actif).length

  const inviter = async (evenement: FormEvent<HTMLFormElement>) => {
    evenement.preventDefault()
    setErreurInvitation(null)

    const nomComplet = invitation.nomComplet.trim()
    const email = invitation.email.trim()
    if (!nomComplet) {
      setErreurInvitation('Le nom complet est obligatoire.')
      return
    }
    // Contrôle volontairement grossier : la vraie validation est celle de
    // Supabase Auth, qui refusera une adresse mal formée.
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      setErreurInvitation('Adresse e-mail invalide.')
      return
    }

    setEnvoiInvitation(true)
    try {
      const url = await utilisateurService.inviter({ ...invitation, nomComplet, email })
      toast.succes(`Compte créé pour « ${nomComplet} ». Transmettez-lui le lien affiché.`)
      setLien({ nature: 'invitation', email, url })
      setInvitation(SAISIE_VIDE)
      await charger()
    } catch (cause) {
      // Le message reste sous le formulaire : la saisie fautive est encore à
      // l'écran, contrairement à une notification qui disparaît.
      setErreurInvitation(cause instanceof Error ? cause.message : "Impossible d'inviter cette personne.")
    } finally {
      setEnvoiInvitation(false)
    }
  }

  const produireLienMotDePasse = async (compte: Profil) => {
    setOccupe(compte.id)
    try {
      const url = await utilisateurService.lienMotDePasse(compte.email)
      toast.succes(`Lien prêt pour « ${compte.nomComplet} ».`)
      setLien({ nature: 'mot-de-passe', email: compte.email, url })
    } catch (cause) {
      toast.erreurDe(cause, 'Impossible de produire un lien de mot de passe.')
    } finally {
      setOccupe(null)
    }
  }

  const commencerEdition = (compte: Profil) => {
    setEdition({ id: compte.id, nomComplet: compte.nomComplet })
    setErreurEdition(null)
  }

  const annulerEdition = () => {
    setEdition(null)
    setErreurEdition(null)
  }

  const enregistrerEdition = async () => {
    if (!edition) return
    const nomComplet = edition.nomComplet.trim()
    if (!nomComplet) {
      setErreurEdition('Le nom ne peut pas être vide.')
      return
    }
    const initial = comptes.find(c => c.id === edition.id)
    if (initial && initial.nomComplet === nomComplet) {
      annulerEdition()
      return
    }
    setOccupe(edition.id)
    try {
      await utilisateurService.renommer(edition.id, nomComplet)
      toast.succes(`Compte renommé en « ${nomComplet} ».`)
      annulerEdition()
      await charger()
      // Le tableau de suivi affiche le nom du traitant depuis sa copie en
      // mémoire : elle doit suivre le renommage.
      void rechargerTickets()
    } catch (cause) {
      // Le message reste sous le champ plutôt que dans une notification qui
      // disparaît : la saisie fautive est encore à l'écran.
      setErreurEdition(cause instanceof Error ? cause.message : 'Impossible de renommer le compte.')
    } finally {
      setOccupe(null)
    }
  }

  const changerRole = async (compte: Profil, role: Role) => {
    setOccupe(compte.id)
    try {
      await utilisateurService.definirRole(compte.id, role)
      toast.succes(role === 'admin'
        ? `« ${compte.nomComplet} » est désormais administrateur.`
        : `« ${compte.nomComplet} » est désormais technicien.`)
      await charger()
    } catch (cause) {
      toast.erreurDe(cause, 'Impossible de changer le rôle.')
    } finally {
      setOccupe(null)
    }
  }

  const basculerActif = async (compte: Profil) => {
    setOccupe(compte.id)
    try {
      await utilisateurService.definirActif(compte.id, !compte.actif)
      toast.succes(compte.actif
        ? `Compte « ${compte.nomComplet} » désactivé : il n'a plus accès à l'application.`
        : `Compte « ${compte.nomComplet} » réactivé.`)
      await charger()
      // Un compte désactivé disparaît de la liste « Traitant » d'une fiche.
      void rechargerTickets()
    } catch (cause) {
      toast.erreurDe(cause, "Impossible de changer l'état du compte.")
    } finally {
      setOccupe(null)
    }
  }

  const choisirDestinataire = async (compte: Profil) => {
    setOccupe(compte.id)
    try {
      await utilisateurService.choisirDestinataire(compte.notificationsEmail ? null : compte.id)
      await charger()
      toast.succes(compte.notificationsEmail ? 'Aucun destinataire sélectionné.' : `Les notifications seront adressées à ${compte.email}.`)
    } catch (cause) {
      toast.erreurDe(cause, 'Impossible de modifier le destinataire.')
    } finally { setOccupe(null) }
  }

  const supprimerCompte = async () => {
    if (!aSupprimer) return
    setOccupe(aSupprimer.id)
    try {
      await utilisateurService.supprimer(aSupprimer.id)
      setASupprimer(null)
      setLien(null)
      await charger()
      await rechargerTickets()
      toast.succes('Compte supprimé. Ses incidents sont désormais non assignés.')
    } catch (cause) {
      toast.erreurDe(cause, 'Impossible de supprimer ce compte.')
    } finally { setOccupe(null) }
  }

  const actionsBloquees = occupe !== null || edition !== null || aSupprimer !== null

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-black uppercase tracking-tight">Utilisateurs</h1>
        <p className="text-sm text-gray-600 mt-1">
          Comptes du personnel habilité à traiter les incidents —{' '}
          {chargement
            ? 'chargement…'
            : `${comptes.length} compte(s), dont ${nbAdmins} administrateur(s) actif(s)${nbInactifs > 0 ? ` et ${nbInactifs} compte(s) désactivé(s)` : ''}.`}
        </p>
      </div>

      <section
        aria-labelledby="invitation-titre"
        className="bg-white border-4 border-black shadow-[8px_8px_0px_0px_rgba(0,0,0,1)] rounded-xl p-6"
      >
        <h2 id="invitation-titre" className="text-lg font-black uppercase tracking-tight mb-3">
          Inviter un utilisateur
        </h2>
        <form onSubmit={inviter} noValidate className="grid grid-cols-1 sm:grid-cols-[1fr_1fr_auto_auto] gap-3 items-start">
          <div>
            <label htmlFor="invitation-nom" className="block text-sm font-bold mb-1">Nom complet *</label>
            <input
              id="invitation-nom"
              type="text"
              placeholder="Ex : Camille Martin"
              value={invitation.nomComplet}
              onChange={e => setInvitation({ ...invitation, nomComplet: e.target.value })}
              aria-invalid={Boolean(erreurInvitation)}
              aria-describedby={erreurInvitation ? 'erreur-invitation' : undefined}
              className={classesChamp(Boolean(erreurInvitation))}
            />
          </div>
          <div>
            <label htmlFor="invitation-email" className="block text-sm font-bold mb-1">Adresse e-mail *</label>
            <input
              id="invitation-email"
              type="email"
              autoComplete="off"
              placeholder="prenom.nom@cesi.fr"
              value={invitation.email}
              onChange={e => setInvitation({ ...invitation, email: e.target.value })}
              aria-invalid={Boolean(erreurInvitation)}
              aria-describedby={erreurInvitation ? 'erreur-invitation' : undefined}
              className={classesChamp(Boolean(erreurInvitation))}
            />
          </div>
          <div>
            <label htmlFor="invitation-role" className="block text-sm font-bold mb-1">Rôle</label>
            <select
              id="invitation-role"
              value={invitation.role}
              onChange={e => setInvitation({ ...invitation, role: e.target.value as Role })}
              className={`${classesSelect} w-full`}
            >
              <option value="technicien">Technicien</option>
              <option value="admin">Administrateur</option>
            </select>
          </div>
          <button type="submit" disabled={envoiInvitation || occupe !== null} className={`${classesBoutonPrincipal} sm:mt-6`}>
            <Icons.Plus /> {envoiInvitation ? 'Création…' : 'Inviter'}
          </button>
        </form>
        {erreurInvitation && (
          <p id="erreur-invitation" role="alert" className="mt-2 text-sm text-red-700 font-medium">{erreurInvitation}</p>
        )}
        <p className="text-xs text-gray-500 mt-3">
          Le compte est créé aussitôt et apparaît dans la liste. Il ne devient utilisable qu'une fois
          le mot de passe choisi depuis le lien produit ci-dessous — rien n'est envoyé automatiquement,
          c'est vous qui transmettez ce lien.
        </p>
      </section>

      {lien && <BoiteLien key={lien.url} lien={lien} onFermer={() => setLien(null)} />}

      <section aria-labelledby="liste-titre" className="bg-white rounded-xl shadow p-4 sm:p-6">
        <p className="text-sm text-gray-600 mb-3">
          Cochez le compte qui recevra le récapitulatif hebdomadaire et les alertes immédiates
          en cas de risque. Cocher un autre compte remplace le précédent.
        </p>
        {!chargement && !comptes.some(c => c.notificationsEmail && c.actif) && (
          <p role="status" className="mb-4 text-sm font-bold text-amber-800">Aucun destinataire sélectionné : les notifications ne peuvent pas être envoyées.</p>
        )}
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 mb-4">
          <h2 id="liste-titre" className="text-lg font-black uppercase tracking-tight">Liste des comptes</h2>
          <div className="relative sm:w-72">
            <span className="absolute inset-y-0 left-3 flex items-center" aria-hidden="true"><Icons.Search /></span>
            <input
              type="search"
              aria-label="Rechercher un compte par nom ou adresse e-mail"
              placeholder="Rechercher…"
              value={recherche}
              onChange={e => setRecherche(e.target.value)}
              className="w-full border-2 border-gray-200 rounded pl-9 pr-2 py-2 min-h-11 focus:border-black outline-none text-sm"
            />
          </div>
        </div>

        <div className="mb-5 p-4 border-2 border-gray-200 rounded-lg bg-gray-50">
          <div className="flex flex-col lg:flex-row lg:items-end gap-4">
            <div className="flex-1">
              <h3 className="font-black text-sm uppercase tracking-tight">
                Récapitulatif hebdomadaire
              </h3>
              <p className="text-sm text-gray-600 mt-1">
                Configurez le jour et l’heure d’envoi du récapitulatif des incidents.
                Les alertes en cas de risque restent envoyées immédiatement.
              </p>
            </div>

            <div>
              <label
                htmlFor="notifications-jour"
                className="block text-sm font-bold mb-1"
              >
                Jour
              </label>
              <select
                id="notifications-jour"
                value={jourNotifications}
                disabled={chargementNotifications || enregistrementNotifications}
                onChange={e => setJourNotifications(Number(e.target.value))}
                className={classesSelect}
              >
                <option value={1}>Lundi</option>
                <option value={2}>Mardi</option>
                <option value={3}>Mercredi</option>
                <option value={4}>Jeudi</option>
                <option value={5}>Vendredi</option>
                <option value={6}>Samedi</option>
                <option value={7}>Dimanche</option>
              </select>
            </div>

            <div>
              <label
                htmlFor="notifications-heure"
                className="block text-sm font-bold mb-1"
              >
                Heure
              </label>
              <input
                id="notifications-heure"
                type="time"
                value={heureNotifications}
                disabled={chargementNotifications || enregistrementNotifications}
                onChange={e => setHeureNotifications(e.target.value)}
                className={classesSelect}
              />
            </div>

            <button
              type="button"
              onClick={() => void enregistrerConfigurationNotifications()}
              disabled={
                chargementNotifications ||
                enregistrementNotifications ||
                !heureNotifications
              }
              className={classesBoutonPrincipal}
            >
              <Icons.Check />
              {enregistrementNotifications ? 'Enregistrement…' : 'Enregistrer'}
            </button>
          </div>

          <p className="text-xs text-gray-500 mt-3">
            Heure de Paris. Le destinataire des e-mails est sélectionné dans le tableau ci-dessous.
          </p>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full text-left border-collapse min-w-3xl">
            <caption className="sr-only">Comptes du personnel, avec leur adresse e-mail, leur rôle et leur état.</caption>
            <thead>
              <tr className="border-b-2 border-black bg-gray-50">
                <th scope="col" className="p-2 font-bold text-sm">Nom affiché</th>
                <th scope="col" className="p-2 font-bold text-sm">E-mail</th>
                <th scope="col" className="p-2 font-bold text-sm">Rôle</th>
                <th scope="col" className="p-2 font-bold text-sm">État</th>
                <th scope="col" className="p-2 font-bold text-sm">Emails incidents</th>
                <th scope="col" className="p-2 font-bold text-sm text-right">Actions</th>
              </tr>
            </thead>
            <tbody>
              {resultats.map(compte => {
                // On ne modifie ni son propre rôle ni son propre état : se
                // rétrograder ou se désactiver coupe l'accès à cet écran même.
                // Le verrou réel est en base (trg_proteger_dernier_admin) ;
                // celui-ci évite simplement d'aller s'y heurter.
                const estMoi = profil?.id === compte.id

                return edition?.id === compte.id ? (
                  <LigneEdition
                    key={compte.id}
                    compte={compte}
                    edition={edition}
                    erreur={erreurEdition}
                    occupe={occupe === compte.id}
                    onChange={setEdition}
                    onEnregistrer={() => void enregistrerEdition()}
                    onAnnuler={annulerEdition}
                  />
                ) : (
                  <tr
                    key={compte.id}
                    className={`border-b transition-colors ${compte.actif ? 'hover:bg-gray-50' : 'bg-gray-50 text-gray-500'}`}
                  >
                    <td className="p-2 font-bold">
                      {compte.nomComplet}
                      {estMoi && <span className="ml-2 text-xs font-medium text-gray-500">(vous)</span>}
                    </td>
                    <td className="p-2 text-sm break-all">{compte.email}</td>
                    <td className="p-2">
                      {estMoi ? (
                        <EtiquetteRole role={compte.role} />
                      ) : (
                        <>
                          <label htmlFor={`role-${compte.id}`} className="sr-only">
                            Rôle de {compte.nomComplet}
                          </label>
                          <select
                            id={`role-${compte.id}`}
                            value={compte.role}
                            disabled={actionsBloquees}
                            onChange={e => void changerRole(compte, e.target.value as Role)}
                            className={classesSelect}
                          >
                            <option value="technicien">Technicien</option>
                            <option value="admin">Administrateur</option>
                          </select>
                        </>
                      )}
                    </td>
                    <td className="p-2"><Etat actif={compte.actif} /></td>
                    <td className="p-2 text-center">
                      <input type="checkbox" checked={compte.notificationsEmail} disabled={actionsBloquees || !compte.actif}
                        aria-label={`Envoyer les notifications à ${compte.nomComplet}`}
                        onChange={() => void choisirDestinataire(compte)} className="w-5 h-5 accent-black" />
                    </td>
                    <td className="p-2">
                      <div className="flex justify-end gap-2">
                        <button
                          type="button"
                          onClick={() => commencerEdition(compte)}
                          disabled={actionsBloquees}
                          aria-label={`Renommer le compte ${compte.nomComplet}`}
                          className={classesBoutonSecondaire}
                        >
                          <Icons.Pencil /> Renommer
                        </button>
                        <button
                          type="button"
                          onClick={() => void produireLienMotDePasse(compte)}
                          disabled={actionsBloquees || !compte.actif}
                          aria-label={`Produire un lien de mot de passe pour ${compte.nomComplet}`}
                          title={compte.actif ? undefined : 'Réactivez le compte pour lui produire un lien.'}
                          className={classesBoutonSecondaire}
                        >
                          Lien mot de passe
                        </button>
                        <button
                          type="button"
                          onClick={() => void basculerActif(compte)}
                          disabled={actionsBloquees || estMoi}
                          aria-label={`${compte.actif ? 'Désactiver' : 'Réactiver'} le compte ${compte.nomComplet}`}
                          title={estMoi ? 'Vous ne pouvez pas désactiver votre propre compte.' : undefined}
                          className={classesBoutonSecondaire}
                        >
                          {occupe === compte.id ? '…' : compte.actif ? 'Désactiver' : 'Réactiver'}
                        </button>
                        <button type="button" onClick={() => setASupprimer(compte)}
                          disabled={actionsBloquees || estMoi || (compte.role === 'admin' && compte.actif && nbAdmins <= 1)}
                          aria-label={`Supprimer le compte ${compte.nomComplet}`} title="Supprimer définitivement le compte"
                          className="inline-flex items-center justify-center min-w-11 min-h-11 rounded text-red-700 hover:bg-red-50 disabled:opacity-30">
                          <Icons.Trash />
                        </button>
                      </div>
                    </td>
                  </tr>
                )
              })}

              {chargement && (
                <tr>
                  <td colSpan={6} className="p-8 text-center text-gray-500" role="status" aria-live="polite">
                    Chargement des comptes…
                  </td>
                </tr>
              )}

              {!chargement && resultats.length === 0 && (
                <tr>
                  <td colSpan={6} className="p-8 text-center text-gray-500">
                    {comptes.length === 0
                      ? 'Aucun compte enregistré.'
                      : 'Aucun compte ne correspond à la recherche.'}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>

      </section>
      {aSupprimer && (
        <ConfirmDialog ouvert titre={`Supprimer le compte de ${aSupprimer.nomComplet} ?`}
          libelleConfirmer="Supprimer définitivement" occupe={occupe !== null}
          onConfirmer={() => void supprimerCompte()} onAnnuler={() => setASupprimer(null)}>
          <p><strong>{aSupprimer.nomComplet}</strong> — {aSupprimer.email}</p>
          <p>Ce compte et son accès seront supprimés définitivement. Tous les incidents attribués à cette personne seront automatiquement remis en « Non assigné ». Les incidents seront conservés.</p>
          {aSupprimer.notificationsEmail && <p className="font-bold">Ce compte reçoit les notifications. Après suppression, vous devrez sélectionner un autre destinataire.</p>}
        </ConfirmDialog>
      )}
    </div>
  )
}
