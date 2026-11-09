import { splitScopes } from './config.ts'

type Interaction = 'c' | 'r' | 'u' | 'd' | 's'

const RESOURCE_SCOPE = /^(?:patient|user)\/(\*|[A-Za-z]+)\.([cruds]+)$/

// Reads the granted scope string from the token response, not the requested one: the server may grant less.
// Only SMART v2 resource scopes are understood (patient/Condition.s, patient/*.cruds). This is a convenience
// for explaining a missing scope, the FHIR server stays the one that enforces it.
export function grantsInteraction(granted: string, resourceType: string, interaction: Interaction): boolean {
    return splitScopes(granted).some((scope) => {
        const match = RESOURCE_SCOPE.exec(scope)

        const resourceMatches = match?.[1] === '*' || match?.[1] === resourceType

        return resourceMatches && Boolean(match?.[2]?.includes(interaction))
    })
}

export function missingScopes(
    granted: string,
    required: { resourceType: string; interaction: Interaction }[],
): string[] {
    return required
        .filter(({ resourceType, interaction }) => !grantsInteraction(granted, resourceType, interaction))
        .map(({ resourceType, interaction }) => `patient/${resourceType}.${interaction}`)
}
