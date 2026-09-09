/** Provider-reported commands and skills. Workspace snapshots override the instance catalog. */
export interface ProviderSlashCommand { name: string; description?: string | undefined; input?: { hint: string } | undefined }
export interface ProviderSkill { name: string; description?: string | undefined; path: string; scope?: string | undefined; enabled: boolean; displayName?: string | undefined; shortDescription?: string | undefined; userInvocationOnly?: boolean | undefined; userInvocable?: boolean | undefined }
export interface ProviderCommandSnapshot { slashCommands: ProviderSlashCommand[]; skills: ProviderSkill[] }
export interface ProviderCommandCatalog extends ProviderCommandSnapshot { instanceId: string; workspaceSnapshots?: Array<ProviderCommandSnapshot & { cwd: string; checkedAt: string }> | undefined }
export function selectedProviderCommands(catalog: readonly ProviderCommandCatalog[], instanceId: string | null | undefined, cwd: string | null | undefined): ProviderCommandSnapshot | undefined {
  const provider = catalog.find(entry => entry.instanceId === instanceId)
  return provider?.workspaceSnapshots?.find(snapshot => snapshot.cwd === cwd) ?? provider
}
export function supportsManualCompaction(snapshot: ProviderCommandSnapshot | undefined): boolean {
  return snapshot?.slashCommands.some(command => command.name === 'compact') ?? false
}
