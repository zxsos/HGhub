/** 品牌常量：所有用户可见名称只从这里取，组件里不再写死产品名。 */
export const APP_NAME = "HghubX";
export const APP_TITLE = "HghubX";
export const APP_DESC = "第三方客户端";
export const APP_REPO = "https://github.com/zxsos/HGhub";

/** 本地数据命名空间。换门牌时由数据层用 sourceKey 分出不同桶，默认桶兼容旧数据。 */
export const APP_DATA_PREFIX = "app_data_v1";
export function appDataKey(sourceKey = "default", scope = "library"): string {
  return `${APP_DATA_PREFIX}:${sourceKey}:${scope}`;
}
