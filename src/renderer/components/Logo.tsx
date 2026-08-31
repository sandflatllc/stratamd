import strataIcon from '../../../resources/stratamd-icon.svg?url'
import strataLogo from '../../../resources/stratamd-logo.svg?url'

export function Logo() {
  return (
    <div className="logo-pill" aria-label="StrataMD">
      <img className="stratamd-logo" src={strataLogo} alt="" aria-hidden="true" />
    </div>
  )
}

export function StrataIcon() {
  return <img className="strata-loader" src={strataIcon} alt="" aria-hidden="true" />
}
