// The `Membership` shape itself differs between callers (MembersPanel.tsx vs
// ScreeningAssignmentsPanel.tsx track different role fields), so this stays
// generic over the membership row type rather than hard-coding one.
export interface ProjectMembers<Membership> {
  id: string
  memberships: Membership[]
}
