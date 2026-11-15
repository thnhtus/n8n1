# SOUL: Quy chuẩn kênh video-factory (kế thừa từ shorts-kit)
<!-- Kế thừa từ https://github.com/howznguyen/shorts-kit SOUL.md, bản địa hóa sang tiếng Việt cho video-factory -->

Kênh tự động hoá của bạn có một "linh hồn" (SOUL): bộ quy chuẩn bất di bất dịch mà mọi video phải tuân thủ. Mọi script LLM, mọi bước render, mọi template đều phải đo theo file này.

## Ba nguyên tắc cốt lõi (Three First Rules)

1. **Facts trước, chữ sau (Facts first, words second):**
   - Không được để LLM bịa thông tin. Mọi con số, mốc thời gian, tuyên bố thực tế đều phải có bản ghi `verified` trong `docs/facts/facts.json` kèm nguồn từ `sources.json`.
   - Mỗi câu nói trong kịch bản phải trỏ về ít nhất 1 `fact` id (hoặc đánh dấu rõ là câu chuyển tiếp).

2. **Quyết định ngôn ngữ hình ảnh & bản quyền TRƯỚC khi viết kịch bản:**
   - Chọn palette màu, phong cách motion, kiểu typography trước.
   - Mọi asset (SFX, nhạc nền, texture) phải thuộc miền công cộng (CC0) hoặc được cấp phép thương mại tự do.

3. **Kết thúc ở "The Turn", KHÔNG làm outro logo (End on the turn):**
   - Không outro "Cảm ơn các bạn đã xem", không màn hình logo kênh 5 giây.
   - Nhịp cuối cùng phủ định một niềm tin sai lệch của người xem, để lại 1 dòng kêu gọi chia sẻ gắn liền nội dung (Share Line), rồi giữ im lặng 3-4 giây (`outroHold: 3`) để thuật toán loop tự nhiên.

## Pipeline chuẩn (Pipeline Order)

```
0. facts   ──>  1. flow/brief  ──>  2. narration  ──>  3. tts  ──>  4. lint
(Kiểm chứng)    (Chọn 1/20 Flow)    (Prompt theo Flow)  (Audio/Word)  (Linter SOUL)
                                                                            │
out/ <──  7. handoff  <──  6. encode+norm  <──  5. render  <────────────────┘
(Duyệt)   (Caption, Cover) (EBU R128 + BT.709) (Remotion)
```

**Nguyên tắc bàn giao (Handoff Rule):** Hệ thống tạo sẵn toàn bộ artifact vào `out/<id>/` (video chuẩn nén, caption, pinned comment, cover thumbnail). Auto-publish chỉ chạy khi người dùng bật `AUTO_PUBLISH=true` hoặc qua bước phê duyệt có chủ đích.

## Ngưỡng kỹ thuật đo lường được (Thresholds)

| Thông số | Ngưỡng | Ý nghĩa |
|---|---|---|
| **Thời lượng video** | 60 - 90 giây (tối đa 180s) | Giữ trọn sự chú ý của người xem Reels/TikTok/Shorts |
| **Outro hold** | 3.0 - 4.0 giây | Giữ khung hình tĩnh cuối để thuật toán loop mượt |
| **Độ dài câu** | Max 25 từ, trung vị ~16 từ | Tránh câu rườm rà, hụt hơi khi đọc |
| **Tỷ lệ câu ngắn (≤7 từ)** | ≤ 13% | Tránh kịch bản nhát gừng |
| **Mật độ sự thật** | Ít nhất 1 fact mỗi 2.5 giây | Video ngắn có giá trị tri thức cao, không sáo rỗng |
| **Vùng an toàn (Safe Zone)** | Top: 212px, Bottom: 1726px, Right: 927px (từ Y=803px) | Tránh bị UI TikTok/Reels đè lên text (like, share, caption) |
| **Bề rộng nội dung tối đa** | 774px (căn giữa trong khung 1080px) | Chữ không bao giờ bị tràn sát biên màn hình |
| **Độ lớn âm thanh (Loudness)**| -13.0 LUFS (±1 LU) | Chuẩn EBU R128 cho mạng xã hội |
| **True Peak tối đa** | ≤ -1.0 dBFS | Chống vỡ tiếng (clipping) khi nén AAC |
| **Tần số lấy mẫu âm thanh** | 48,000 Hz (48 kHz), AAC 192kbps | Chuẩn phát sóng video |
| **Màu sắc & Encode video** | H.264, yuv420p, BT.709, TV range, +faststart | Không bị nền tảng crush màu |
| **Cover readability test** | Đọc được ở 200px (grid view) | 1 con số lớn + tối đa 3-4 từ nổi bật |

## Danh sách từ cấm tiếng Việt (Banned Phrases)

Script không bao giờ được chứa những từ sáo rỗng/câu view rẻ tiền sau:
- "Bạn có biết", "Bạn sẽ không tin đâu", "Sự thật bất ngờ là"
- "Video này sẽ giúp bạn", "Chào mừng các bạn đến với kênh", "Đừng quên like và sub"
- "Trong video hôm nay", "Tóm lại là", "Link ở dưới phần mô tả"
- Dấu câu cấm trong lời đọc TTS: dấu gạch ngang dài `—`, `–`, dấu hai chấm `:`, chữ viết tắt `v.v.`
