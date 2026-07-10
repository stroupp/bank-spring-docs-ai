import { ScannedFile } from "./repositoryScanner";

export interface EntityIndex {
  entity: string;
  table?: string;
  idField?: string;
  fields: Array<{ name: string; type: string; column?: string }>;
  relationships: Array<{ field: string; type: string; targetType: string }>;
  file: string;
}

export class SpringEntityExtractor {
  extract(files: ScannedFile[]): EntityIndex[] {
    return files
      .filter((file) => file.kind === "java" && file.classification === "entity")
      .map((file) => this.extractOne(file))
      .filter((entity): entity is EntityIndex => Boolean(entity));
  }

  private extractOne(file: ScannedFile): EntityIndex | undefined {
    if (!/@Entity\b/.test(file.content)) {
      return undefined;
    }
    const entity = file.content.match(/\bclass\s+([A-Za-z0-9_]+)/)?.[1];
    if (!entity) {
      return undefined;
    }
    const fields = [...file.content.matchAll(/(?:@Column\((?:name\s*=\s*)?["']([^"']+)["']\)\s*)?(?:private|protected)\s+([A-Za-z0-9_<>]+)\s+([A-Za-z0-9_]+)\s*;/g)]
      .map((match) => ({ name: match[3], type: match[2], column: match[1] }));
    const relationships = [...file.content.matchAll(/@(OneToOne|OneToMany|ManyToOne|ManyToMany)\b[\s\S]{0,160}?(?:private|protected)\s+([A-Za-z0-9_<>]+)\s+([A-Za-z0-9_]+)\s*;/g)]
      .map((match) => ({ type: match[1], targetType: match[2], field: match[3] }));
    const idField = file.content.match(/@Id[\s\S]{0,120}?(?:private|protected)\s+[A-Za-z0-9_<>]+\s+([A-Za-z0-9_]+)\s*;/)?.[1];

    return {
      entity,
      table: file.content.match(/@Table\s*\([^)]*name\s*=\s*["']([^"']+)["']/)?.[1],
      idField,
      fields,
      relationships,
      file: file.file
    };
  }
}
