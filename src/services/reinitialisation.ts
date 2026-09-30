import { supabase } from '../lib/supabase'

export interface ResultatReinitialisation {
  reinitialise: boolean
  incidents_supprimes: number
  photos_supprimees: number
}

type ReponseReinitialisation = Partial<ResultatReinitialisation> & {
  erreur?: string
}

export const reinitialisationService = {
  async incidents(): Promise<ResultatReinitialisation> {
    const { data, error } =
      await supabase.functions.invoke<ReponseReinitialisation>(
        'reinitialisation-incidents',
        { body: {} },
      )

    if (error) {
      const contexte = (error as { context?: unknown }).context

      if (contexte instanceof Response) {
        const corps = await contexte.json().catch(() => null) as ReponseReinitialisation | null

        if (corps?.erreur) {
          throw new Error(corps.erreur)
        }
      }

      throw new Error(error.message)
    }

    if (!data?.reinitialise) {
      throw new Error(
        data?.erreur ?? 'La réinitialisation des incidents n’a pas été confirmée par le serveur.',
      )
    }

    return {
      reinitialise: true,
      incidents_supprimes: Number(data.incidents_supprimes ?? 0),
      photos_supprimees: Number(data.photos_supprimees ?? 0),
    }
  },
}
