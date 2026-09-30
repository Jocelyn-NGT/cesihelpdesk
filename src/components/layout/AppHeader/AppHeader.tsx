import { NavLink, useNavigate } from 'react-router'
import { useAuth } from '../../../hooks/useAuth'
import { Icons } from '../../ui/Icons/Icons'

const lienClasses = ({ isActive }: { isActive: boolean }) =>
  `flex items-center gap-2 px-3 py-2 rounded transition-colors min-h-11 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cesi-jaune ${
    isActive ? 'bg-white/20 font-bold' : 'hover:bg-white/10 text-gray-300'
  }`

export const AppHeader = () => {
  const { profil, deconnexion } = useAuth()
  const navigate = useNavigate()

  const seDeconnecter = async () => {
    await deconnexion()
    navigate('/signaler')
  }

  return (
    <header className="bg-black text-white sticky top-0 z-40 shadow-md">
      <div className="max-w-7xl mx-auto px-4 min-h-16 flex flex-wrap items-center justify-between gap-2 py-2">
        <NavLink to="/signaler" className="flex items-center gap-4 rounded focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cesi-jaune">
          <span className="bg-cesi-jaune text-black font-black text-xl px-3 py-1 -skew-x-12 inline-block">CESI</span>
          <span className="font-bold hidden sm:inline tracking-wide">HELP DESK</span>
        </NavLink>

        <nav aria-label="Navigation principale" className="flex items-center gap-1 sm:gap-2">
          <NavLink to="/signaler" className={lienClasses}>
            <Icons.Home /> <span className="hidden sm:inline">Signaler</span>
          </NavLink>

          {/* Les liens d'administration n'apparaissent qu'une fois connecté.
              Ce masquage est cosmétique : ce sont les politiques RLS qui
              protègent réellement les données. */}
          {profil && (
            <>
              <span className="w-px h-6 bg-gray-600 mx-1" aria-hidden="true" />
              <NavLink to="/suivi" className={lienClasses} title="Suivi des incidents">
                <Icons.List /> <span className="hidden sm:inline">Suivi</span>
              </NavLink>
              <NavLink to="/statistiques" className={lienClasses} title="Statistiques">
                <Icons.Chart /> <span className="hidden sm:inline">Stats</span>
              </NavLink>
              <NavLink to="/qr-codes" className={lienClasses} title="QR codes des salles">
                <Icons.QrCode /> <span className="hidden sm:inline">QR</span>
              </NavLink>
              {profil.role === 'admin' && (
                <>
                  <NavLink to="/salles" className={lienClasses} title="Gestion des salles">
                    <Icons.Building /> <span className="hidden sm:inline">Salles</span>
                  </NavLink>
                  <NavLink to="/utilisateurs" className={lienClasses} title="Gestion des comptes du personnel">
                    <Icons.Users /> <span className="hidden sm:inline">Admin</span>
                  </NavLink>
                </>
              )}
            </>
          )}
        </nav>

        <div className="flex items-center gap-2">
          {profil ? (
            <>
              <span className="hidden md:inline text-sm text-gray-300 max-w-40 truncate" title={`${profil.nomComplet} — ${profil.role}`}>
                {profil.nomComplet}
              </span>
              <button
                type="button"
                onClick={seDeconnecter}
                title="Se déconnecter"
                className="flex items-center gap-2 px-3 py-2 min-h-11 rounded text-gray-300 hover:bg-white/10 transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-cesi-jaune"
              >
                <Icons.Logout /> <span className="hidden lg:inline">Déconnexion</span>
              </button>
            </>
          ) : (
            <NavLink to="/connexion" className={lienClasses}>
              <span className="text-sm">Connexion</span>
            </NavLink>
          )}
        </div>
      </div>
    </header>
  )
}
