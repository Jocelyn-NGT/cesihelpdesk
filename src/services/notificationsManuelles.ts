import { supabase } from '../lib/supabase'

export interface ResultatNotificationManuelle {
  statut?: 'envoye' | 'partiel'
  emails_envoyes?: number
  incidents_envoyes?: number
  incidents_ignores?: number[]
  echecs?: {
    traitant: string
    erreur: string
  }[]
  erreur?: string
}

export const envoyerNotificationsManuelles = async (
  ticketIds: string[],
): Promise<ResultatNotificationManuelle> => {
  const { data, error } =
    await supabase.functions.invoke<ResultatNotificationManuelle>(
      'notifications-manuelles',
      {
        body: {
          ticket_ids: ticketIds,
        },
      },
    )

  if (error) {
    const contexte = (error as { context?: unknown }).context

    if (contexte instanceof Response) {
      const corps =
        await contexte.json().catch(() => null) as ResultatNotificationManuelle | null

      if (corps?.erreur) {
        throw new Error(corps.erreur)
      }
    }

    throw new Error(
      `Impossible d'envoyer les notifications : ${error.message}`,
    )
  }

  if (!data) {
    throw new Error('Réponse inattendue du serveur.')
  }

  if (data.erreur) {
    throw new Error(data.erreur)
  }

  return data
}
