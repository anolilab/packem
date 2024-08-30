export interface NamedSelfExport {
    exportedName: string;
    from: "self";
    type: "named";
}

export interface ExportBinding {
    exportedName: string;
    importedName: string;
}

export interface NamedReExport {
    bindings: ExportBinding[];
    from: "other";
    source: string;
    type: "named";
}

export interface BarrelReExport {
    from: "other";
    source: string;
    type: "barrel";
}

export type ParsedExportInfo = NamedSelfExport | NamedReExport | BarrelReExport;