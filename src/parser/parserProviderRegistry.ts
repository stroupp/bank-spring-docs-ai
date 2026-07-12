import { ParserLanguage, ParserProvider } from "./parserProviderTypes";

export class ParserProviderRegistry {
  private readonly providers = new Map<ParserLanguage, Map<string, ParserProvider>>();

  register(provider: ParserProvider): void {
    const languageProviders = this.providers.get(provider.identity.language) ?? new Map<string, ParserProvider>();
    if (languageProviders.has(provider.identity.name)) {
      throw new Error(`Parser provider already registered: ${provider.identity.language}/${provider.identity.name}`);
    }
    languageProviders.set(provider.identity.name, provider);
    this.providers.set(provider.identity.language, languageProviders);
  }

  get<T extends ParserProvider>(language: ParserLanguage, name: string): T | undefined {
    return this.providers.get(language)?.get(name) as T | undefined;
  }

  list(language?: ParserLanguage): ParserProvider[] {
    if (language) {
      return [...(this.providers.get(language)?.values() ?? [])];
    }
    return [...this.providers.values()].flatMap((items) => [...items.values()]);
  }
}
