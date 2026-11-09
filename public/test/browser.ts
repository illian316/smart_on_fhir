import type { FastifyInstance } from 'fastify'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'

import { splitScopes } from '../src/config.ts'

import type { Fixture } from './fixture.ts'

export type LaunchResponse = Awaited<ReturnType<FastifyInstance['inject']>>

interface BrowserLaunch {
    response: LaunchResponse
    authorizeUrl: URL
    state: string
    launchCookie: LaunchResponse['cookies'][number]
}

export async function startBrowserLaunch(app: FastifyInstance, f: Fixture): Promise<BrowserLaunch> {
    const query = new URLSearchParams({ iss: f.config.fhirBase, launch: 'launch' })
    const response = await app.inject(`/launch?${query}`)

    assert.equal(response.statusCode, 302, response.body)

    const authorizeUrl = new URL(response.headers.location!)

    return {
        response,
        authorizeUrl,
        state: authorizeUrl.searchParams.get('state')!,
        launchCookie: response.cookies.find((c) => c.name === 'smart_launch')!,
    }
}

export function callbackPath(state: string, code: string): string {
    return `/callback?${new URLSearchParams({ state, code })}`
}

export async function completeBrowserLaunch(app: FastifyInstance, f: Fixture, code = 'code'): Promise<LaunchResponse> {
    const { state, launchCookie } = await startBrowserLaunch(app, f)

    return app.inject({ url: callbackPath(state, code), cookies: { smart_launch: launchCookie.value } })
}

export function sessionCookieValue(callback: LaunchResponse): string {
    return callback.cookies.find((c) => c.name === 'smart_session')!.value
}

// A full launch and callback against the fixture, returning the session cookie. The fixture grants
// `grantedScopes` (default: the registered SCOPES), whatever the app requested.
export async function signIn(app: FastifyInstance, f: Fixture, grantedScopes = f.config.scopes): Promise<string> {
    const { authorizeUrl, state, launchCookie } = await startBrowserLaunch(app, f)

    for (const scope of splitScopes(grantedScopes)) {
        if (!f.registeredScopes.includes(scope)) {
            f.registeredScopes.push(scope)
        }
    }

    const code = randomUUID()
    f.registerCode(code, authorizeUrl.searchParams.get('code_challenge')!, grantedScopes)

    const callback = await app.inject({
        url: callbackPath(state, code),
        cookies: { smart_launch: launchCookie.value },
    })

    assert.equal(callback.statusCode, 302, callback.body)

    return sessionCookieValue(callback)
}
