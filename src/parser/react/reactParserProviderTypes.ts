import { ReactApiCallRecord } from "../../analyzer/ui/reactApiCallExtractor";
import { ReactComponentRecord } from "../../analyzer/ui/reactComponentExtractor";
import { ReactFormFieldRecord } from "../../analyzer/ui/reactFormFieldExtractor";
import { ReactInteractionRecord } from "../../analyzer/ui/reactInteractionExtractor";
import { ReactRouteRecord } from "../../analyzer/ui/reactRouteExtractor";
import { ReactStateRecord } from "../../analyzer/ui/reactStateExtractor";
import { ParserProvider } from "../parserProviderTypes";

export type ParsedReactRoute = ReactRouteRecord;
export type ParsedReactComponent = ReactComponentRecord;
export type ParsedReactInteraction = ReactInteractionRecord;
export type ParsedReactApiCall = ReactApiCallRecord;
export type ParsedReactFormField = ReactFormFieldRecord;
export type ParsedReactStateUsage = ReactStateRecord;

export interface ReactParserProvider extends ParserProvider {
  parseRoutes(filePath: string, source: string): ParsedReactRoute[];
  parseComponents(filePath: string, source: string): ParsedReactComponent[];
  parseInteractions(filePath: string, source: string): ParsedReactInteraction[];
  parseApiCalls(filePath: string, source: string): ParsedReactApiCall[];
  parseFormFields(filePath: string, source: string): ParsedReactFormField[];
  parseStateUsage(filePath: string, source: string): ParsedReactStateUsage[];
}
