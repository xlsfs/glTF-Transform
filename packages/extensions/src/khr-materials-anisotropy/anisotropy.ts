import {
	ExtensionProperty,
	IProperty,
	Nullable,
	PropertyType,
	Texture,
	TextureChannel,
	TextureInfo,
	vec3,
} from '@gltf-transform/core';
import { KHR_MATERIALS_ANISOTROPY } from '../constants';

interface IAnisotropy extends IProperty {
	anisotropyFactor: number;
	anisotropyTexture: Texture;
	anisotropyTextureInfo: TextureInfo;
	anisotropyDirectionFactor: vec3;
	anisotropyDirectionTexture: Texture;
	anisotropyDirectionTextureInfo: TextureInfo;
}

const { R, G, B } = TextureChannel;

/**
 * # Anisotropy
 *
 * Defines anisotropy (thin film interference) on a PBR {@link Material}. See {@link MaterialsAnisotropy}.
 */
export class Anisotropy extends ExtensionProperty<IAnisotropy> {
	public static EXTENSION_NAME = KHR_MATERIALS_ANISOTROPY;
	public declare extensionName: typeof KHR_MATERIALS_ANISOTROPY;
	public declare propertyType: 'Anisotropy';
	public declare parentTypes: [PropertyType.MATERIAL];

	protected init(): void {
		this.extensionName = KHR_MATERIALS_ANISOTROPY;
		this.propertyType = 'Anisotropy';
		this.parentTypes = [PropertyType.MATERIAL];
	}

	protected getDefaults(): Nullable<IAnisotropy> {
		return Object.assign(super.getDefaults() as IProperty, {
			anisotropyFactor: 0.0,
			anisotropyTexture: null,
			anisotropyTextureInfo: new TextureInfo(this.graph, 'anisotropyTextureInfo'),
			anisotropyDirectionFactor: [1, 0, 0] as vec3,
			anisotropyDirectionTexture: null,
			anisotropyDirectionTextureInfo: new TextureInfo(this.graph, 'anisotropyDirectionTextureInfo'),
		});
	}

	/**********************************************************************************************
	 * Anisotropy.
	 */

	/** Anisotropy; linear multiplier. See {@link getAnisotropyTexture}. */
	public getAnisotropyFactor(): number {
		return this.get('anisotropyFactor');
	}

	/** Anisotropy; linear multiplier. See {@link getAnisotropyTexture}. */
	public setAnisotropyFactor(factor: number): this {
		return this.set('anisotropyFactor', factor);
	}

	/**
	 * Anisotropy.
	 *
	 * Only the red (R) channel is used for anisotropy, but this texture may optionally
	 * be packed with additional data in the other channels.
	 */
	public getAnisotropyTexture(): Texture | null {
		return this.getRef('anisotropyTexture');
	}

	/**
	 * Settings affecting the material's use of its anisotropy texture. If no texture is attached,
	 * {@link TextureInfo} is `null`.
	 */
	public getAnisotropyTextureInfo(): TextureInfo | null {
		return this.getRef('anisotropyTexture') ? this.getRef('anisotropyTextureInfo') : null;
	}

	/** Anisotropy. See {@link getAnisotropyTexture}. */
	public setAnisotropyTexture(texture: Texture | null): this {
		return this.setRef('anisotropyTexture', texture, { channels: R });
	}

	/**********************************************************************************************
	 * Anisotropy direction.
	 */

	/** Anisotropy direction; linear multiplier. */
	public getAnisotropyDirectionFactor(): vec3 {
		return this.get('anisotropyDirectionFactor');
	}

	/** Anisotropy direction; linear multiplier. */
	public setAnisotropyDirectionFactor(factor: vec3): this {
		return this.set('anisotropyDirectionFactor', factor);
	}

	/** Anisotropy direction. */
	public getAnisotropyDirectionTexture(): Texture | null {
		return this.getRef('anisotropyDirectionTexture');
	}

	/**
	 * Settings affecting the material's use of its anisotropy direction texture. If no texture is attached,
	 * {@link TextureInfo} is `null`.
	 */
	public getAnisotropyDirectionTextureInfo(): TextureInfo | null {
		return this.getRef('anisotropyDirectionTexture') ? this.getRef('anisotropyDirectionTextureInfo') : null;
	}

	/** Anisotropy direction. */
	public setAnisotropyDirectionTexture(texture: Texture | null): this {
		return this.setRef('anisotropyDirectionTexture', texture, { channels: R | G | B });
	}
}
