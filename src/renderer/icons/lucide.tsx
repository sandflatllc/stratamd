// Icon paths from lucide-react v0.564.0 (ISC license, https://lucide.dev), the icon set t3 code uses.
// Copied as path data so Strata needs no extra package; keep this file to icons the shell actually renders.
import type { SVGProps } from 'react'

type IconNode = ReadonlyArray<readonly [string, Record<string, string>]>

export type IconProps = SVGProps<SVGSVGElement> & { size?: number }

function icon(name: string, node: IconNode) {
  const Component = ({ size = 16, className, ...rest }: IconProps) => <svg xmlns="http://www.w3.org/2000/svg" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false" className={className ? `lucide lucide-${name} ${className}` : `lucide lucide-${name}`} {...rest}>{node.map(([tag, attrs], index) => { const Tag = tag as 'path'; return <Tag key={index} {...attrs} /> })}</svg>
  Component.displayName = name
  return Component
}

export const FolderIcon = icon('folder', [["path",{"d":"M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z"}]])
export const FolderGit2Icon = icon('folder-git-2', [["path",{"d":"M18 19a5 5 0 0 1-5-5v8"}],["path",{"d":"M9 20H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h3.9a2 2 0 0 1 1.69.9l.81 1.2a2 2 0 0 0 1.67.9H20a2 2 0 0 1 2 2v5"}],["circle",{"cx":"13","cy":"12","r":"2"}],["circle",{"cx":"20","cy":"19","r":"2"}]])
export const FolderGitIcon = icon('folder-git', [["circle",{"cx":"12","cy":"13","r":"2"}],["path",{"d":"M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z"}],["path",{"d":"M14 13h3"}],["path",{"d":"M7 13h3"}]])
export const HistoryIcon = icon('history', [["path",{"d":"M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"}],["path",{"d":"M3 3v5h5"}],["path",{"d":"M12 7v5l4 2"}]])
export const GitBranchIcon = icon('git-branch', [["path",{"d":"M15 6a9 9 0 0 0-9 9V3"}],["circle",{"cx":"18","cy":"6","r":"3"}],["circle",{"cx":"6","cy":"18","r":"3"}]])
export const TerminalIcon = icon('terminal', [["path",{"d":"M12 19h8"}],["path",{"d":"m4 17 6-6-6-6"}]])
export const SquareTerminalIcon = icon('square-terminal', [["path",{"d":"m7 11 2-2-2-2"}],["path",{"d":"M11 13h4"}],["rect",{"width":"18","height":"18","x":"3","y":"3","rx":"2","ry":"2"}]])
export const ChartColumnIcon = icon('chart-column', [["path",{"d":"M3 3v16a2 2 0 0 0 2 2h16"}],["path",{"d":"M18 17V9"}],["path",{"d":"M13 17V5"}],["path",{"d":"M8 17v-3"}]])
export const UserRoundIcon = icon('user-round', [["circle",{"cx":"12","cy":"8","r":"5"}],["path",{"d":"M20 21a8 8 0 0 0-16 0"}]])
export const GlobeIcon = icon('globe', [["circle",{"cx":"12","cy":"12","r":"10"}],["path",{"d":"M12 2a14.5 14.5 0 0 0 0 20 14.5 14.5 0 0 0 0-20"}],["path",{"d":"M2 12h20"}]])
export const FileTextIcon = icon('file-text', [["path",{"d":"M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8Z"}],["path",{"d":"M14 2v6h6M8 13h8M8 17h6"}]])
export const MessageSquareIcon = icon('message-square', [["path",{"d":"M21 15a2 2 0 0 1-2 2H7l-5 5V4a2 2 0 0 1 2-2h15a2 2 0 0 1 2 2Z"}]])
export const SearchIcon = icon('search', [["path",{"d":"m21 21-4.34-4.34"}],["circle",{"cx":"11","cy":"11","r":"8"}]])
export const RefreshCwIcon = icon('refresh-cw', [["path",{"d":"M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8"}],["path",{"d":"M21 3v5h-5"}],["path",{"d":"M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16"}],["path",{"d":"M8 16H3v5"}]])
export const EllipsisIcon = icon('ellipsis', [["circle",{"cx":"12","cy":"12","r":"1"}],["circle",{"cx":"19","cy":"12","r":"1"}],["circle",{"cx":"5","cy":"12","r":"1"}]])
export const ChevronDownIcon = icon('chevron-down', [["path",{"d":"m6 9 6 6 6-6"}]])
export const XIcon = icon('x', [["path",{"d":"M18 6 6 18"}],["path",{"d":"m6 6 12 12"}]])
export const ArrowUpIcon = icon('arrow-up', [["path",{"d":"m5 12 7-7 7 7"}],["path",{"d":"M12 19V5"}]])
export const PlusIcon = icon('plus', [["path",{"d":"M5 12h14"}],["path",{"d":"M12 5v14"}]])
export const CheckIcon = icon('check', [["path",{"d":"M20 6 9 17l-5-5"}]])
export const CornerLeftUpIcon = icon('corner-left-up', [["path",{"d":"M14 9 9 4 4 9"}],["path",{"d":"M20 20h-7a4 4 0 0 1-4-4V4"}]])
export const FolderPlusIcon = icon('folder-plus', [["path",{"d":"M12 10v6"}],["path",{"d":"M9 13h6"}],["path",{"d":"M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z"}]])
export const StarIcon = icon('star', [["path",{"d":"M11.525 2.295a.53.53 0 0 1 .95 0l2.31 4.679a2.123 2.123 0 0 0 1.595 1.16l5.166.756a.53.53 0 0 1 .294.904l-3.736 3.638a2.123 2.123 0 0 0-.611 1.878l.882 5.14a.53.53 0 0 1-.771.56l-4.618-2.428a2.122 2.122 0 0 0-1.973 0L6.396 21.01a.53.53 0 0 1-.77-.56l.881-5.139a2.122 2.122 0 0 0-.611-1.879L2.16 9.795a.53.53 0 0 1 .294-.906l5.165-.755a2.122 2.122 0 0 0 1.597-1.16z"}]])
export const EyeIcon = icon('eye', [["path",{"d":"M2.062 12.348a1 1 0 0 1 0-.696 10.75 10.75 0 0 1 19.876 0 1 1 0 0 1 0 .696 10.75 10.75 0 0 1-19.876 0"}],["circle",{"cx":"12","cy":"12","r":"3"}]])
export const EyeOffIcon = icon('eye-off', [["path",{"d":"M10.733 5.076a10.744 10.744 0 0 1 11.205 6.575 1 1 0 0 1 0 .696 10.747 10.747 0 0 1-1.444 2.49"}],["path",{"d":"M14.084 14.158a3 3 0 0 1-4.242-4.242"}],["path",{"d":"M17.479 17.499a10.75 10.75 0 0 1-15.417-5.151 1 1 0 0 1 0-.696 10.75 10.75 0 0 1 4.446-5.143"}],["path",{"d":"m2 2 20 20"}]])
export const Settings2Icon = icon('settings-2', [["path",{"d":"M14 17H5"}],["path",{"d":"M19 7h-9"}],["circle",{"cx":"17","cy":"17","r":"3"}],["circle",{"cx":"7","cy":"7","r":"3"}]])
export const LinkIcon = icon('link', [["path",{"d":"M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"}],["path",{"d":"M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"}]])
export const ExternalLinkIcon = icon('external-link', [["path",{"d":"M15 3h6v6"}],["path",{"d":"M10 14 21 3"}],["path",{"d":"M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"}]])
export const ArrowLeftIcon = icon('arrow-left', [["path",{"d":"m12 19-7-7 7-7"}],["path",{"d":"M19 12H5"}]])
export const ChevronRightIcon = icon('chevron-right', [["path",{"d":"m9 18 6-6-6-6"}]])
export const SquarePenIcon = icon('square-pen', [["path",{"d":"M12 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"}],["path",{"d":"M18.375 2.625a1 1 0 0 1 3 3l-9.013 9.014a2 2 0 0 1-.853.505l-2.873.84a.5.5 0 0 1-.62-.62l.84-2.873a2 2 0 0 1 .506-.852z"}]])
