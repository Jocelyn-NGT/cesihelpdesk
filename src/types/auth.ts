/**
 * Rôle d'un membre du personnel.
 *
 * - `admin` : accès complet (suivi, statistiques, QR codes, gestion des salles et des comptes)
 * - `technicien` : suivi, traitement et suppression des incidents, impression des affiches à QR code
 *
 * Le rôle est stocké dans `utilisateurs.role` et vérifié **côté base** par les
 * politiques RLS. Le masquer dans l'interface est un confort, pas une sécurité.
 */
export type Role = 'admin' | 'technicien'

/** Saisie du formulaire d'invitation d'un nouveau membre du personnel. */
export interface InvitationInput {
  /** Nom complet affiché dans la colonne « Traitant » */
  nomComplet: string
  /** Adresse e-mail, qui servira d'identifiant de connexion */
  email: string
  /** Rôle attribué à la création */
  role: Role
}

/** Compte du personnel, tel que lu dans la table `utilisateurs`. */
export interface Profil {
  /** Destinataire unique du récapitulatif et des alertes urgentes. */
  notificationsEmail: boolean
  /** Identifiant, identique à `auth.users.id` */
  id: string
  /** Nom complet affiché dans la colonne « Traitant » */
  nomComplet: string
  /** Adresse e-mail professionnelle (sert aussi d'identifiant de connexion) */
  email: string
  /** Rôle attribué */
  role: Role
  /** Un compte désactivé ne peut plus rien lire ni modifier */
  actif: boolean
}
