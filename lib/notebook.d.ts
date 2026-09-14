/** On-demand notebook guidance, not a note store or a mutation protocol. */
export declare function notebookDirectories(targetRoot: string): {
    notebook_path: string;
    sources_path: string;
};
export declare function researchNotebookGuide(targetRoot: string, sessionId: string): {
    session_id: string;
    instructions: string;
    notebook_path: string;
    sources_path: string;
};
//# sourceMappingURL=notebook.d.ts.map