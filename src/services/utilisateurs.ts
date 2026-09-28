/**
 * Service d'accès et de gestion de l'annuaire du personnel.
 *
 * Alimente la liste déroulante « Traitant » du tableau de suivi. L'ancienne
 * version stockait un nom libre et cherchait l'utilisateur par comparaison de
 * chaîne : une faute de frappe faisait échouer l'affectation. On manipule
 * désormais des identifiants.
 *
 * Cette table n'est jamais lisible par un visiteur anonyme (noms et adresses
 * professionnelles — RGPD).
 *
 * Les écritures sont réservées aux administrateurs par la politique
 * `utilisateurs_gestion_admin`, et limitées aux colonnes `nom_complet`, `role`
 * et `actif` par un GRANT au niveau colonne. La suppression définitive passe par la fonction Edge comptes : elle supprime
 * aussi l’identité Auth et libère les incidents attribués.
 *
 * La création, elle, ne passe pas par cette table : l'identité vit dans
 * `auth.users`, hors de portée du navigateur. Elle passe par la fonction Edge
 * « comptes », seule détentrice de la clé de service (`inviter` ci-dessous).
 */

import { supabase } from '../lib/supabase'
import type { InvitationInput, Profil, Role } from '../types/auth'

type UtilisateurRow = {
  notifications_email: boolean
  id: string
  nom_complet: string
  email: string
  role: Role
  actif: boolean
}

const SELECTION_PROFIL = 'id, nom_complet, email, role, actif'
const SELECTION = `${SELECTION_PROFIL}, notifications_email`

const mapProfil = (row: UtilisateurRow): Profil => ({
  notificationsEmail: Boolean(row.notifications_email),
  id: row.id,
  nomComplet: row.nom_complet,
  email: row.email,
  role: row.role,
  actif: row.actif,
})

/**
 * Traduit une erreur PostgREST en message lisible.
 *
 * `P0001` est le code d'un `raise exception` : le message vient de la base et
 * s'adresse déjà à l'administrateur (dernier administrateur actif, par
 * exemple). Le noyer derrière un repli générique perdrait la seule explication
 * utile. `42501` est le refus d'un GRANT : la colonne visée n'est pas
 * modifiable depuis l'application.
 */
const messageErreur = (error: { code?: string; message: string }, repli: string): string => {
  if (error.code === 'P0001') return error.message
  if (error.code === '42501') return `${repli} : cette modification n'est pas autorisée depuis l'application.`
  return `${repli} : ${error.message}`
}

/** Réponse de la fonction Edge « comptes » : un lien, ou une explication. */
type ReponseComptes = { lien?: string; erreur?: string }

/**
 * Appelle la fonction Edge « comptes » et rend le lien qu'elle a fabriqué.
 *
 * `functions.invoke` transmet automatiquement le jeton de la session en cours :
 * c'est lui que la fonction contrôle avant d'accepter quoi que ce soit.
 *
 * Sur une réponse d'erreur, ce client range le corps HTTP dans `error.context`
 * plutôt que dans le message — sans le relire, on perdrait l'explication
 * fournie par la fonction (« adresse déjà utilisée », « compte désactivé »…)
 * au profit d'un « Edge Function returned a non-2xx status code » inutilisable.
 */
const lienDeLaFonctionComptes = async (charge: Record<string, unknown>, repli: string): Promise<string> => {
  const { data, error } = await supabase.functions.invoke<ReponseComptes>('comptes', { body: charge })

  if (error) {
    const contexte = (error as { context?: unknown }).context
    if (contexte instanceof Response) {
      const corps = (await contexte.json().catch(() => null)) as ReponseComptes | null
      if (corps?.erreur) throw new Error(corps.erreur)
    }
    throw new Error(`${repli} : ${error.message}`)
  }

  if (!data?.lien) throw new Error(`${repli} : réponse inattendue du serveur.`)
  return data.lien
}

export const utilisateurService = {
  async choisirDestinataire(id: string | null): Promise<void> {
    const { error } = await supabase.rpc('choisir_destinataire_notifications', { p_id: id })
    if (error) throw new Error(messageErreur(error, 'Impossible de choisir le destinataire'))
  },

  async supprimer(id: string): Promise<void> {
    const { data, error } = await supabase.functions.invoke<{ supprime?: boolean; erreur?: string }>('comptes', {
      body: { action: 'supprimer', id },
    })
    if (error) {
      const contexte = (error as { context?: unknown }).context
      if (contexte instanceof Response) {
        const corps = await contexte.json().catch(() => null) as { erreur?: string } | null
        if (corps?.erreur) throw new Error(corps.erreur)
      }
      throw new Error(error.message)
    }
    if (!data?.supprime) throw new Error(data?.erreur || 'Suppression non confirmée.')
  },
  /**
   * Charge le compte du personnel correspondant à un identifiant d'authentification.
   *
   * @param id Identifiant `auth.users.id`.
   * @returns Le profil, ou `null` si le compte n'est pas habilité.
   * @throws {Error} Si la requête échoue.
   */
  async getProfil(id: string): Promise<Profil | null> {
    const { data, error } = await supabase
      .from('utilisateurs')
      .select(SELECTION_PROFIL)
      .eq('id', id)
      .maybeSingle()

    if (error) throw new Error(`Impossible de charger le profil : ${error.message}`)
    return data ? mapProfil(data as UtilisateurRow) : null
  },

  /**
   * Liste les membres actifs du personnel, triés par nom.
   *
   * @returns Liste des profils pouvant se voir affecter un incident.
   * @throws {Error} Si la requête échoue.
   */
  async listActifs(): Promise<Profil[]> {
    const { data, error } = await supabase
      .from('utilisateurs')
      .select(SELECTION_PROFIL)
      .eq('actif', true)
      .order('nom_complet', { ascending: true })

    if (error) throw new Error(`Impossible de charger l'annuaire : ${error.message}`)
    return (data as UtilisateurRow[]).map(mapProfil)
  },

  /**
   * Liste tous les comptes, désactivés compris, triés par nom.
   *
   * Réservé à l'écran d'administration : un compte désactivé n'a rien à faire
   * dans la liste des traitants, d'où la méthode distincte de `listActifs`.
   *
   * @returns Liste de tous les comptes du personnel.
   * @throws {Error} Si la requête échoue.
   */
  async listerTous(): Promise<Profil[]> {
    const { data, error } = await supabase
      .from('utilisateurs')
      .select(SELECTION)
      .order('nom_complet', { ascending: true })

    if (error) throw new Error(`Impossible de charger la liste des comptes : ${error.message}`)
    return (data as UtilisateurRow[]).map(mapProfil)
  },

  /**
   * Corrige le nom affiché d'un compte.
   *
   * Ce nom apparaît dans la colonne « Traitant » des incidents déjà traités :
   * la correction est rétroactive, les fiches référençant le compte par son
   * identifiant.
   *
   * @param id Identifiant du compte.
   * @param nomComplet Nouveau nom affiché.
   * @throws {Error} Si l'écriture est refusée.
   */
  async renommer(id: string, nomComplet: string): Promise<void> {
    const { error } = await supabase
      .from('utilisateurs')
      .update({ nom_complet: nomComplet.trim() })
      .eq('id', id)

    if (error) throw new Error(messageErreur(error, 'Impossible de renommer le compte'))
  },

  /**
   * Change le rôle d'un compte.
   *
   * L'effet est immédiat côté données : les politiques RLS relisent la table à
   * chaque requête. En revanche, la personne concernée doit recharger la page
   * pour que son menu reflète le nouveau rôle.
   *
   * @param id Identifiant du compte.
   * @param role `admin` ou `technicien`.
   * @throws {Error} Si l'écriture est refusée, notamment sur le dernier administrateur actif.
   */
  async definirRole(id: string, role: Role): Promise<void> {
    const { error } = await supabase
      .from('utilisateurs')
      .update({ role })
      .eq('id', id)

    if (error) throw new Error(messageErreur(error, 'Impossible de changer le rôle'))
  },

  /**
   * Active ou désactive un compte.
   *
   * Un compte désactivé ne lit plus rien (les politiques RLS exigent
   * `actif = true`) et disparaît de la liste des traitants, mais les incidents
   * qu'il a traités conservent son nom.
   *
   * @param id Identifiant du compte.
   * @param actif `false` pour couper l'accès, `true` pour le rétablir.
   * @throws {Error} Si l'écriture est refusée, notamment sur le dernier administrateur actif.
   */
  async definirActif(id: string, actif: boolean): Promise<void> {
    const { error } = await supabase
      .from('utilisateurs')
      .update({ actif })
      .eq('id', id)

    if (error) throw new Error(messageErreur(error, "Impossible de changer l'état du compte"))
  },

  /**
   * Crée un compte et rend le lien d'activation à transmettre à la personne.
   *
   * Rien n'est envoyé : l'instance n'a pas de relais SMTP pour Supabase Auth.
   * L'administrateur copie le lien et le transmet lui-même. Le compte existe
   * dès maintenant et apparaît dans la liste ; il n'est utilisable qu'une fois
   * le mot de passe choisi depuis ce lien.
   *
   * @param saisie Nom complet, adresse e-mail et rôle du nouveau compte.
   * @returns Le lien d'activation, à usage unique.
   * @throws {Error} Si l'adresse est déjà prise ou si la création est refusée.
   */
  async inviter(saisie: InvitationInput): Promise<string> {
    return lienDeLaFonctionComptes(
      {
        action: 'inviter',
        email: saisie.email.trim(),
        nom_complet: saisie.nomComplet.trim(),
        role: saisie.role,
      },
      "Impossible d'inviter cette personne",
    )
  },

  /**
   * Produit un lien de réinitialisation de mot de passe pour un compte existant.
   *
   * Même mécanique que l'invitation, et même écran d'arrivée : c'est la réponse
   * à « j'ai oublié mon mot de passe », l'instance ne pouvant pas expédier
   * elle-même l'e-mail de récupération.
   *
   * @param email Adresse du compte concerné.
   * @returns Le lien de réinitialisation, à usage unique.
   * @throws {Error} Si le compte est inconnu ou désactivé.
   */
  async lienMotDePasse(email: string): Promise<string> {
    return lienDeLaFonctionComptes(
      { action: 'reinitialiser', email: email.trim() },
      'Impossible de produire un lien de mot de passe',
    )
  },
}
