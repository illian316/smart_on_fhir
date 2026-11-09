import type { FastifyInstance } from 'fastify'

import type { Fixture } from './fixture.ts'

export type InjectResponse = Awaited<ReturnType<FastifyInstance['inject']>>

export interface BrowserLaunch {
    response: InjectResponse
    authorizeUrl: URL
    state: string
    launchCookie: string
    progressCookie: string
}

export function launchPath(f: Fixture, launch = 'synthetic-launch-id-0001'): string {
    return `/launch?${new URLSearchParams({ iss: f.config.fhirBase, launch })}`
}

export async function startBrowserLaunch(
    app: FastifyInstance,
    f: Fixture,
    launch?: string,
    cookies: Record<string, string> = {},
): Promise<BrowserLaunch> {
    const response = await app.inject({ url: launchPath(f, launch), cookies })

    if (response.statusCode !== 302) {
        throw new Error(`Launch failed with ${response.statusCode}: ${response.body}`)
    }

    const authorizeUrl = new URL(response.headers.location as string)

    return {
        response,
        authorizeUrl,
        state: authorizeUrl.searchParams.get('state') as string,
        launchCookie: cookieValue(response, 'smart_launch'),
        progressCookie: cookieValue(response, 'smart_progress'),
    }
}

export function callbackPath(state: string, code = 'synthetic-code-0123456789'): string {
    return `/callback?${new URLSearchParams({ state, code })}`
}

export function cookieValue(response: InjectResponse, name: string): string {
    const cookie = response.cookies.find((candidate) => candidate.name === name)

    if (!cookie) {
        throw new Error(`Missing cookie ${name}`)
    }

    return cookie.value
}

export async function completeBrowserLaunch(app: FastifyInstance, f: Fixture): Promise<InjectResponse> {
    const { state, launchCookie } = await startBrowserLaunch(app, f)

    return app.inject({ url: callbackPath(state), cookies: { smart_launch: launchCookie } })
}
