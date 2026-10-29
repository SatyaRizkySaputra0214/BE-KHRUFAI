export interface AuthSession {
  session_hash: string
  csrf_hash: string
  user_id: string | null
  expires_at: string | Date
  username?: string | null
  nama_lengkap?: string | null
  email?: string | null
  role?: string | null
  rawToken: string
}

export interface AuthenticatedSession extends AuthSession {
  user_id: string
  role: string
}
