/**
 * Transport d'envoi des e-mails.
 *
 * Deux modes, choisis par le secret `MAIL_TRANSPORT` :
 *
 * - `console` (par défaut) : le message est écrit dans les journaux de la
 *   fonction, sans être envoyé.
 * - `smtp` : envoi réel via le relais SMTP configuré.
 */

import { SMTPClient } from 'https://deno.land/x/denomailer@1.6.0/mod.ts'

/** Message à envoyer. */
export interface Message {
  destinataires: string[]
  sujet: string
  html: string
  texte: string
}

/** Résultat d'un envoi, journalisé dans `email_log`. */
export interface ResultatEnvoi {
  statut: 'envoye' | 'echec' | 'simule'
  erreur?: string
}

/** Lit une variable d'environnement. */
const secret = (nom: string, defaut = ''): string =>
  Deno.env.get(nom) ?? defaut

/**
 * Découpe une liste de destinataires séparés par des virgules
 * ou des points-virgules.
 */
export const listerDestinataires = (brut: string): string[] =>
  brut
    .split(/[,;]/)
    .map(adresse => adresse.trim())
    .filter(Boolean)

/**
 * Envoie un message selon le transport configuré.
 *
 * Ne lève jamais d'exception :
 * l'échec est renvoyé pour pouvoir être journalisé.
 */
export const envoyer = async (
  message: Message,
): Promise<ResultatEnvoi> => {

  // Vérification des destinataires
  if (message.destinataires.length === 0) {
    return {
      statut: 'echec',
      erreur: 'Aucun destinataire configuré.',
    }
  }

  // Mode d'envoi
  const transport = secret('MAIL_TRANSPORT', 'console')

  /**
   * MODE CONSOLE
   */
  if (transport !== 'smtp') {
    console.log('=== CESI HELPDESK — EMAIL SIMULÉ ===')
    console.log('Destinataires :', message.destinataires.join(', '))
    console.log('Sujet :', message.sujet)
    console.log('Texte :')
    console.log(message.texte)
    console.log('=====================================')

    return {
      statut: 'simule',
    }
  }

  /**
   * MODE SMTP
   */
  const hote = secret('SMTP_HOST')
  const port = Number(secret('SMTP_PORT', '587'))
  const utilisateur = secret('SMTP_USER')
  const motDePasse = secret('SMTP_PASSWORD')

  const adresseExpediteur = secret(
    'SMTP_FROM',
    utilisateur,
  )

  const nomExpediteur = secret('SMTP_SENDER_NAME')

  const expediteur = nomExpediteur
    ? `${nomExpediteur} <${adresseExpediteur}>`
    : adresseExpediteur

  /**
   * Vérification de la configuration SMTP.
   */
  if (!hote || !utilisateur || !motDePasse) {
    return {
      statut: 'echec',
      erreur:
        'Configuration SMTP incomplète : SMTP_HOST, SMTP_USER ou SMTP_PASSWORD manquant.',
    }
  }

  /**
   * Protection contre l'ancien serveur SMTP interne.
   */
  if (hote === 'supabase-mail') {
    return {
      statut: 'echec',
      erreur:
        'SMTP_HOST pointe encore vers supabase-mail. Configurez le serveur SMTP externe.',
    }
  }

  /**
   * Création du client SMTP.
   *
   * Port 465 -> TLS immédiat
   * Port 587 -> STARTTLS géré par Denomailer
   */
  const client = new SMTPClient({
    connection: {
      hostname: hote,
      port,
      tls: port === 465,
      auth: {
        username: utilisateur,
        password: motDePasse,
      },
    },
  })

  /**
   * Abandon de l'envoi au bout de 30 secondes.
   */
  let minuteur: number | undefined

  const delai = new Promise<never>((_, rejeter) => {
    minuteur = setTimeout(
      () =>
        rejeter(
          new Error('Délai SMTP dépassé (30 s).'),
        ),
      30_000,
    )
  })

  /**
   * Nettoyage du HTML avant l'encodage MIME.
   *
   * Les espaces d'indentation présents sur les lignes HTML peuvent être
   * encodés en quoted-printable (=20) par certains transports SMTP.
   *
   * On supprime donc les indentations et lignes vides inutiles avant
   * de transmettre le HTML à Denomailer.
   */
  const htmlNettoye = message.html
    .split('\n')
    .map(ligne => ligne.trim())
    .filter(ligne => ligne.length > 0)
    .join('')

  try {

    /**
     * Envoi du message.
     *
     * Denomailer gère l'encodage MIME.
     * Le HTML lui est transmis sans espaces d'indentation inutiles.
     */
    await Promise.race([
      client.send({
        from: expediteur,
        to: message.destinataires,
        subject: message.sujet,
        content: message.texte,
        html: htmlNettoye,
      }),
      delai,
    ])

    return {
      statut: 'envoye',
    }

  } catch (cause) {

    return {
      statut: 'echec',
      erreur:
        cause instanceof Error
          ? cause.message
          : String(cause),
    }

  } finally {

    if (minuteur !== undefined) {
      clearTimeout(minuteur)
    }

    try {
      await client.close()
    } catch {
      // La connexion est peut-être déjà fermée.
    }
  }
}
