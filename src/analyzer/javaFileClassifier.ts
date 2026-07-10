export type JavaFileType =
  | "controller"
  | "service"
  | "repository"
  | "entity"
  | "dto"
  | "mapper"
  | "client"
  | "config"
  | "exception"
  | "model"
  | "test"
  | "util"
  | "unknown";

export function classifyJavaFile(relativePath: string, content: string): JavaFileType {
  const normalized = relativePath.toLowerCase();
  const className = content.match(/\b(?:class|interface|enum)\s+([A-Za-z0-9_]+)/)?.[1] ?? "";
  const annotations = content.match(/@\w+/g)?.join(" ") ?? "";

  if (normalized.includes("/src/test/") || /@(SpringBootTest|WebMvcTest|DataJpaTest|Test)\b/.test(annotations) || /Test(s)?$/.test(className)) {
    return "test";
  }
  if (/@(RestController|Controller)\b/.test(annotations) || /Controller$/.test(className) || normalized.includes("/controller/")) {
    return "controller";
  }
  if (/@Service\b/.test(annotations) || /Service$/.test(className) || normalized.includes("/service/")) {
    return "service";
  }
  if (/@Repository\b/.test(annotations) || /\bextends\s+\w*Repository\b/.test(content) || /Repository$/.test(className) || normalized.includes("/repository/")) {
    return "repository";
  }
  if (/@Entity\b/.test(annotations) || /Entity$/.test(className) || normalized.includes("/entity/")) {
    return "entity";
  }
  if (/@Configuration\b/.test(annotations) || /Config(uration)?$/.test(className) || normalized.includes("/config/")) {
    return "config";
  }
  if (/Dto$|DTO$|Request$|Response$/.test(className) || normalized.includes("/dto/")) {
    return "dto";
  }
  if (/Mapper$/.test(className) || normalized.includes("/mapper/")) {
    return "mapper";
  }
  if (/Client$/.test(className) || /FeignClient/.test(content) || normalized.includes("/client/")) {
    return "client";
  }
  if (/Exception$/.test(className) || normalized.includes("/exception/")) {
    return "exception";
  }
  if (/Model$/.test(className) || normalized.includes("/model/")) {
    return "model";
  }
  if (/Util(s)?$/.test(className) || normalized.includes("/util/")) {
    return "util";
  }
  return "unknown";
}
