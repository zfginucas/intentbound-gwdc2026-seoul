import type { CatalogResponse, PlanResponse, RecommendResponse, StatusResponse } from './types'

export class ApiError extends Error {
  constructor(message: string, readonly status: number | null = null) {
    super(message)
    this.name = 'ApiError'
  }
}

export async function apiRequest<T>(path: string, init?: RequestInit): Promise<T> {
  let response: Response
  try {
    response = await fetch(path, {
      ...init,
      headers: {
        'Content-Type': 'application/json',
        ...init?.headers,
      },
    })
  } catch {
    throw new ApiError('The local API is not reachable. Start the project server and retry.')
  }

  const body = await response.json().catch(() => null) as Record<string, unknown> | null
  if (!response.ok) {
    const error = body?.error
    const detail = typeof error === 'string' ? error : error && typeof error === 'object' && 'message' in error ? (error as { message?: unknown }).message : body?.message
    throw new ApiError(typeof detail === 'string' ? detail : `Request failed (${response.status}).`, response.status)
  }
  return body as T
}

export const getStatus = () => apiRequest<StatusResponse>('/api/status')
export const getCatalog = () => apiRequest<CatalogResponse>('/api/catalog')
export const planWithAgent = (message: string, demoFallback: boolean) => apiRequest<PlanResponse>('/api/agent/plan', {
  method: 'POST',
  body: JSON.stringify({ message, demoFallback }),
})
export const recommendWithAgent = (preferences: PlanResponse['draftPolicy']['preferences'], policy: { budget: number; allowedMerchantIds: string[] }, demoFallback: boolean) => apiRequest<RecommendResponse>('/api/agent/recommend', {
  method: 'POST',
  body: JSON.stringify({ preferences, policy, demoFallback }),
})
