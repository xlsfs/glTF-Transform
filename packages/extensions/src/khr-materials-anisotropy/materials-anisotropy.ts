import { Extension, GLTF, MathUtils, ReaderContext, vec3, WriterContext } from '@gltf-transform/core';
import { KHR_MATERIALS_ANISOTROPY } from '../constants';
import { Anisotropy } from './anisotropy';

const NAME = KHR_MATERIALS_ANISOTROPY;

interface AnisotropyDef {
	anisotropyFactor: number;
	anisotropyTexture: GLTF.ITextureInfo;
	anisotropyDirectionFactor: vec3;
	anisotropyDirectionTexture: GLTF.ITextureInfo;
}

/**
 * # MaterialsAnisotropy
 *
 * [`KHR_materials_anisotropy`](https://github.com/KhronosGroup/gltf/blob/main/extensions/2.0/Khronos/KHR_materials_anisotropy/)
 * defines anisotropy (directionally-dependent reflections) on a PBR material.
 *
 * Anisotropy describes ... TODO
 *
 * Properties:
 * - {@link Anisotropy}
 *
 * ### Example
 *
 * The `MaterialsAnisotropy` class provides a single {@link ExtensionProperty} type, `Anisotropy`,
 * which may be attached to any {@link Material} instance. For example:
 *
 * ```typescript
 * import { MaterialsAnisotropy, Anisotropy } from '@gltf-transform/extensions';
 *
 * // Create an Extension attached to the Document.
 * const anisotropyExtension = document.createExtension(MaterialsAnisotropy);
 *
 * // Create an Anisotropy property.
 * const anisotropy = anisotropyExtension.createAnisotropy()
 * 	.setAnisotropyFactor(1.0)
 * 	.setAnisotropyDirection([1, 0, 0]);
 *
 * // Attach the property to a Material.
 * material.setExtension('KHR_materials_anisotropy', anisotropy);
 * ```
 */
export class MaterialsAnisotropy extends Extension {
	public readonly extensionName = NAME;
	public static readonly EXTENSION_NAME = NAME;

	/** Creates a new Anisotropy property for use on a {@link Material}. */
	public createAnisotropy(): Anisotropy {
		return new Anisotropy(this.document.getGraph());
	}

	/** @hidden */
	public read(context: ReaderContext): this {
		const jsonDoc = context.jsonDoc;
		const materialDefs = jsonDoc.json.materials || [];
		const textureDefs = jsonDoc.json.textures || [];
		materialDefs.forEach((materialDef, materialIndex) => {
			if (materialDef.extensions && materialDef.extensions[NAME]) {
				const anisotropy = this.createAnisotropy();
				context.materials[materialIndex].setExtension(NAME, anisotropy);

				const anisotropyDef = materialDef.extensions[NAME] as AnisotropyDef;

				// Factors.

				if (anisotropyDef.anisotropyFactor !== undefined) {
					anisotropy.setAnisotropyFactor(anisotropyDef.anisotropyFactor);
				}
				if (anisotropyDef.anisotropyDirectionFactor !== undefined) {
					anisotropy.setAnisotropyDirectionFactor(anisotropyDef.anisotropyDirectionFactor);
				}

				// Textures.

				if (anisotropyDef.anisotropyTexture !== undefined) {
					const textureInfoDef = anisotropyDef.anisotropyTexture;
					const texture = context.textures[textureDefs[textureInfoDef.index].source!];
					anisotropy.setAnisotropyTexture(texture);
					context.setTextureInfo(anisotropy.getAnisotropyTextureInfo()!, textureInfoDef);
				}
				if (anisotropyDef.anisotropyDirectionTexture !== undefined) {
					const textureInfoDef = anisotropyDef.anisotropyDirectionTexture;
					const texture = context.textures[textureDefs[textureInfoDef.index].source!];
					anisotropy.setAnisotropyDirectionTexture(texture);
					context.setTextureInfo(anisotropy.getAnisotropyDirectionTextureInfo()!, textureInfoDef);
				}
			}
		});

		return this;
	}

	/** @hidden */
	public write(context: WriterContext): this {
		const jsonDoc = context.jsonDoc;

		this.document
			.getRoot()
			.listMaterials()
			.forEach((material) => {
				const anisotropy = material.getExtension<Anisotropy>(NAME);
				if (anisotropy) {
					const materialIndex = context.materialIndexMap.get(material)!;
					const materialDef = jsonDoc.json.materials![materialIndex];
					materialDef.extensions = materialDef.extensions || {};

					// Factors.

					const anisotropyDef = (materialDef.extensions[NAME] = {} as AnisotropyDef);

					if (anisotropy.getAnisotropyFactor() > 0) {
						anisotropyDef.anisotropyFactor = anisotropy.getAnisotropyFactor();
					}
					if (!MathUtils.eq(anisotropy.getAnisotropyDirectionFactor(), [1, 0, 0])) {
						anisotropyDef.anisotropyFactor = anisotropy.getAnisotropyFactor();
					}

					// Textures.

					if (anisotropy.getAnisotropyTexture()) {
						const texture = anisotropy.getAnisotropyTexture()!;
						const textureInfo = anisotropy.getAnisotropyTextureInfo()!;
						anisotropyDef.anisotropyTexture = context.createTextureInfoDef(texture, textureInfo);
					}
					if (anisotropy.getAnisotropyDirectionTexture()) {
						const texture = anisotropy.getAnisotropyDirectionTexture()!;
						const textureInfo = anisotropy.getAnisotropyDirectionTextureInfo()!;
						anisotropyDef.anisotropyDirectionTexture = context.createTextureInfoDef(texture, textureInfo);
					}
				}
			});

		return this;
	}
}
