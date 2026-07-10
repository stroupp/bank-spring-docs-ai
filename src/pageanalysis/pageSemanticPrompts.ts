export const pageSemanticPromptVersion = "page-analysis-semantic-v2";

export function buildPageSemanticPrompt(context: string): string {
  return `You are a senior enterprise software architect and React/Spring technical analyst.

Analyze the selected UI page using the provided page context and focused source evidence.

Rules:
- Use only provided context.
- Do not invent behavior.
- If a conclusion is inferred, mark it as inferred.
- If something is not visible, write "Not visible from provided context."
- Return strict JSON only.
- Do not include Markdown.

JSON schema:
{
  "page": string,
  "route": string,
  "businessPurpose": string,
  "technicalPurpose": string,
  "mainUserActions": string[],
  "uiComponents": string[],
  "apiCalls": string[],
  "bffResponsibilities": string[],
  "backendResponsibilities": string[],
  "dataFlow": string[],
  "dtoAndModelUsage": string[],
  "parameterMappings": string[],
  "validationAndErrorHandling": string[],
  "securityObservations": string[],
  "risks": string[],
  "changeImpact": string[],
  "confidence": "high" | "medium" | "low",
  "uncertainties": string[]
}

Context:
${context}`;
}

export function buildInteractionSemanticPrompt(context: string): string {
  return `You are a senior React and enterprise banking UI documentation analyst.

Analyze this UI interaction and explain what happens technically and why.

Rules:
- Use only provided context.
- Do not invent behavior.
- If inferred, mark it as inferred.
- If not visible, write "Not visible from provided context."
- Return strict JSON only.

JSON schema:
{
  "page": string,
  "interaction": string,
  "handler": string,
  "purpose": string,
  "whyUsed": string,
  "parameters": [
    {
      "name": string,
      "source": string,
      "meaning": string,
      "sentTo": string,
      "confidence": "high" | "medium" | "low"
    }
  ],
  "apiCall": string,
  "bffEndpoint": string,
  "beEndpoint": string,
  "responseUsage": string,
  "dtoAndModelUsage": string,
  "backendValidation": string[],
  "stateChanges": string[],
  "validationMeaning": string,
  "riskIfChanged": string,
  "confidence": "high" | "medium" | "low",
  "uncertainties": string[]
}

Context:
${context}`;
}
