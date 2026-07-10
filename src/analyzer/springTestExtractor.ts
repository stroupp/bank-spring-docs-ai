import { ScannedFile } from "./repositoryScanner";

export interface TestIndex {
  className: string;
  file: string;
  frameworks: string[];
  testMethods: string[];
}

export class SpringTestExtractor {
  extract(files: ScannedFile[]): TestIndex[] {
    return files.filter((file) => file.classification === "test").map((file) => ({
      className: file.content.match(/\bclass\s+([A-Za-z0-9_]+)/)?.[1] ?? "",
      file: file.file,
      frameworks: [
        file.content.includes("org.junit") ? "JUnit" : "",
        file.content.includes("Mockito") ? "Mockito" : "",
        file.content.includes("@SpringBootTest") ? "SpringBootTest" : "",
        file.content.includes("@WebMvcTest") ? "WebMvcTest" : "",
        file.content.includes("@DataJpaTest") ? "DataJpaTest" : ""
      ].filter(Boolean),
      testMethods: [...file.content.matchAll(/@Test[\s\r\n]+(?:public\s+)?void\s+([A-Za-z0-9_]+)\s*\(/g)].map((match) => match[1])
    }));
  }
}
