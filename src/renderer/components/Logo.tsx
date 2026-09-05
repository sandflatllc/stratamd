import strataIcon from '../../../resources/stratamd-icon.svg?url'
import strataLogo from '../../../resources/stratamd-logo.svg?url'

export function Logo({ compact = false }: { compact?: boolean }) {
  return (
    <div className="logo-pill" aria-label="StrataMD">
      {compact && <img className="stratamd-compact-logo" src={strataIcon} alt="" aria-hidden="true" />}
      <img className="stratamd-logo" src={strataLogo} alt="" aria-hidden="true" />
    </div>
  )
}

export function StrataIcon() {
  return <img className="strata-loader" src={strataIcon} alt="" aria-hidden="true" />
}
