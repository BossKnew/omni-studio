CREATE TABLE "StylePreset" (
    "id" TEXT NOT NULL,
    "nameZh" TEXT NOT NULL,
    "nameEn" TEXT NOT NULL,
    "suffixZh" TEXT NOT NULL,
    "suffixEn" TEXT NOT NULL,
    "previewObjectKey" TEXT,
    "sortOrder" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "StylePreset_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "StylePreset_sortOrder_id_idx" ON "StylePreset"("sortOrder", "id");

INSERT INTO "StylePreset" ("id", "nameZh", "nameEn", "suffixZh", "suffixEn", "sortOrder", "createdAt", "updatedAt") VALUES
('cinematic', '电影感', 'Cinematic', '电影剧照，变形宽银幕镜头，浅景深，金色轮廓光，细腻胶片颗粒，电影调色，戏剧性光影', 'cinematic film still, anamorphic widescreen, shallow depth of field, golden rim light, fine film grain, cinematic color grade', 0, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
('storybook', '水彩绘本', 'Storybook', '手绘水彩故事绘本，柔和边缘，厚涂背景，暖金色自然光，怀旧童话氛围，细腻纸纹', 'hand-painted watercolor storybook illustration, soft edges, gouache background, warm golden natural light, nostalgic fairy-tale mood', 1, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
('anime', '二次元', 'Anime', '日系动画静帧，赛璐珞上色，干净线稿，大而有神的眼睛，影视级光影，高饱和但干净的色彩', 'Japanese anime still frame, cel shading, clean line art, large expressive eyes, cinematic lighting, saturated but clean colors', 2, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
('figurine', '3D 手办', 'Figurine', '收藏级三维角色手办，光滑 PVC 材质，亚克力底座，橱窗陈列灯光，微距产品摄影', 'collectible 3D character figurine, glossy PVC, acrylic display base, cabinet lighting, macro product photography', 3, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
('ink-wash', '国风水墨', 'Ink wash', '中国水墨，宣纸肌理，焦浓淡墨层次，大面积留白，淡青绿点染，写意而不潦草', 'Chinese ink wash painting, xuan paper texture, layered ink values, generous negative space, light blue-green tint, expressive but controlled brushwork', 4, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
('clay', '黏土', 'Clay', '定格黏土动画，手工橡皮泥纹理，圆润形体，柔和摄影棚灯光，微距拍摄', 'stop-motion clay animation, handmade plasticine texture, rounded forms, soft studio lighting, macro photography', 5, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
('film', '胶片', 'Film', '35mm 彩色负片人像，温暖肤色，轻微颗粒和漏光，自然窗光，纪实摄影，浅景深', '35mm color negative portrait, warm skin tones, light grain and light leak, natural window light, documentary photography, shallow depth of field', 6, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
('product', '电商产品', 'Product', '商业产品摄影，纯白无缝背景，柔箱照明，锐利材质细节，目录级构图，中心摆放', 'commercial product photography, seamless white backdrop, softbox lighting, sharp material detail, catalog composition, centered subject', 7, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP);
