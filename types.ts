export interface Source {
	name: string;
	path: string;
	temporary: boolean;
	config: Config;
}

export interface Config {
	files?: string[];
	removeFiles?: string[];
	npmDependencies?: boolean;
	npmScripts?: boolean;
	package?: {
		engines?: boolean;
		dependencies?: boolean;
		devDependencies?: boolean
		optionalDependencies?: boolean;
		peerDependencies?: boolean;
		scripts?: boolean;
	}
}

export type Package = Record<string, any>;

export interface Changes {
	sources: {
		[path: string]: SourceChanges | undefined;
	};
}

export interface SourceChanges {
	files: string[];
	package: Package;
}
