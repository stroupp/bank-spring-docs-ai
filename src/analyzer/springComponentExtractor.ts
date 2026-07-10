import { ScannedFile } from "./repositoryScanner";

export interface SpringComponent {
  type: string;
  className: string;
  packageName: string;
  file: string;
  annotations: string[];
  stereotype?: string;
  basePath?: string;
  constructorDependencies: string[];
  fieldInjectedDependencies: string[];
  implementedInterfaces: string[];
  extendedClass?: string;
}

const stereotypeAnnotations = [
  "RestController",
  "Controller",
  "Service",
  "Repository",
  "Component",
  "Configuration",
  "ControllerAdvice",
  "SpringBootApplication"
];

export class SpringComponentExtractor {
  extract(files: ScannedFile[]): SpringComponent[] {
    return files
      .filter((file) => file.kind === "java")
      .map((file) => this.extractOne(file))
      .filter((component): component is SpringComponent => Boolean(component));
  }

  private extractOne(file: ScannedFile): SpringComponent | undefined {
    const content = file.content;
    const classMatch = content.match(/\b(?:public\s+)?(?:abstract\s+)?(?:class|interface|enum)\s+([A-Za-z0-9_]+)([^{]*)/);
    if (!classMatch) {
      return undefined;
    }

    const annotations = [...content.matchAll(/@([A-Za-z0-9_]+)(?:\([^)]*\))?/g)].map((match) => match[1]);
    const stereotype = annotations.find((annotation) => stereotypeAnnotations.includes(annotation));
    const className = classMatch[1];
    const type = file.classification ?? this.typeFromStereotype(stereotype);

    if (!stereotype && type === "unknown") {
      return undefined;
    }

    return {
      type,
      className,
      packageName: content.match(/\bpackage\s+([A-Za-z0-9_.]+)\s*;/)?.[1] ?? "",
      file: file.file,
      annotations: [...new Set(annotations)],
      stereotype,
      basePath: extractAnnotationPath(content, "RequestMapping"),
      constructorDependencies: this.constructorDependencies(content, className),
      fieldInjectedDependencies: this.fieldInjectedDependencies(content),
      implementedInterfaces: classMatch[2].match(/\bimplements\s+([A-Za-z0-9_,\s<>]+)/)?.[1]?.split(",").map((value) => value.trim()) ?? [],
      extendedClass: classMatch[2].match(/\bextends\s+([A-Za-z0-9_<>]+)/)?.[1]
    };
  }

  private typeFromStereotype(stereotype: string | undefined): string {
    if (!stereotype) {
      return "unknown";
    }
    if (stereotype === "RestController" || stereotype === "Controller") {
      return "controller";
    }
    if (stereotype === "ControllerAdvice") {
      return "exception";
    }
    if (stereotype === "SpringBootApplication") {
      return "config";
    }
    return stereotype.toLowerCase();
  }

  private constructorDependencies(content: string, className: string): string[] {
    const constructor = content.match(new RegExp(`${className}\\s*\\(([^)]*)\\)`));
    if (!constructor) {
      return [];
    }
    return constructor[1]
      .split(",")
      .map((param) => param.trim().match(/^final\s+([A-Za-z0-9_<>]+)|^([A-Za-z0-9_<>]+)\s+\w+/)?.[1] ?? param.trim().match(/^([A-Za-z0-9_<>]+)\s+\w+/)?.[1])
      .filter((value): value is string => Boolean(value));
  }

  private fieldInjectedDependencies(content: string): string[] {
    return [...content.matchAll(/@Autowired[\s\r\n]+(?:private|protected|public)?\s*(?:final\s+)?([A-Za-z0-9_<>]+)\s+\w+/g)].map((match) => match[1]);
  }
}

export function extractAnnotationPath(content: string, annotation: string): string | undefined {
  const match = content.match(new RegExp(`@${annotation}\\s*(?:\\(\\s*(?:value\\s*=\\s*)?["']([^"']+)["']|\\(\\s*path\\s*=\\s*["']([^"']+)["'])`));
  return match?.[1] ?? match?.[2];
}
