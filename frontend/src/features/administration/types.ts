// The `Membership` shape itself differs between callers (MembersPanel.tsx vs
// ScreeningAssignmentsPanel.tsx track different role fields), so this stays
// generic over the membership row type rather than hard-coding one.
export interface ProjectMembers<Membership> {
  id: string
  memberships: Membership[]
}

// What `GET /projects/:id/member-candidates` returns: identity only. The
// instance-wide `/users` directory is administrator-only, so membership and
// assignment screens resolve reviewer names through this project-scoped
// endpoint instead.
export interface MemberCandidate {
  id: string
  username: string
  displayName: string
  isActive: boolean
}
