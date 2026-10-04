# Church Media Team — User Guide

Welcome to **Church Media Tools**. It has three tools:

- **Photo Watermarker** — adds the church logo to your photographs.
- **Video Converter** — turns videos from cameras and phones into MP4 files that play everywhere.
- **Church News** — writes down what is said in a news video, lists the posters needed, and puts the presenter into a news studio.

The photo and video tools work straight from Google Drive and **never change your original files**. They always put the results in a new folder.

---

## Signing In
1. Open the application in your web browser.
2. Click **"Sign in with Google"** and authorize access to your Google Drive. (This allows the app to read your media folders and create processed copies.)
3. Choose a tool: **Open Photo Watermarker** or **Open Video Converter**. You can return to this screen at any time with **← All tools**.

---

## Photo Watermarker

### 1. Enter Folder Link
1. Go to Google Drive, open the folder containing your photographs, and copy its web link from your browser URL bar.
2. Paste the link into the **"Paste Google Drive Folder Link"** field on the application screen.
3. *(Optional)* Check **"Include photos inside subfolders"** if your photos are organized in subfolders.
4. Click **"Validate Folder."**

### 2. Preview Watermark
1. Once validated, you will see the folder name and total number of photos found.
2. Click **"Preview Watermark"** to test how the church logo will look on one of your photos before processing the entire batch.

### 3. Process Photos
1. Click **"Process Photos."**
2. Watch the live progress bar as each photo is watermarked and uploaded to a new Google Drive folder named **`[Original Folder Name] — Watermarked`**.
3. Your original photos remain completely untouched in their original folder.
4. **Pause** stops uploading straight away (for example when you need the internet for something else). Press **Resume** to carry on; the photo that was interrupted is done again from the start.
5. **Cancel** stops the batch. Photos already finished stay in the Watermarked folder; the rest are not processed.

### 4. Open Results
1. When complete, click **"Open Google Drive Folder"** to view your finished watermarked photographs directly in Google Drive.

---

## Video Converter

Paste the Google Drive folder containing your videos. The system will automatically convert supported videos to MP4 and place the converted copies in a new Google Drive folder. Your original videos are never changed.

You don't need to know anything about codecs or settings — the converter decides the best method for each video on its own.

### 1. Find your videos
1. In Google Drive, open the folder with your videos and copy the link from the browser's address bar (it looks like `https://drive.google.com/drive/folders/...`).
2. Paste it into **Google Drive folder** and click **Find Videos**.
3. You'll see how many videos were found. Files that aren't videos (photos, documents) are ignored.

**Formats it understands:** MP4, MOV, M4V, AVI, MKV, WEBM, WMV, FLV, MPEG/MPG, 3GP, TS, MTS, M2TS and OGV.

### 2. Convert
1. Click **Convert Videos to MP4**.
2. A new folder is created inside your original folder, named **`[Original Folder Name] — MP4 Converted`**.
3. **If you've converted this folder before**, you'll be asked what to do:
   - **Create a new conversion folder** — starts fresh in a new folder (e.g. `… — MP4 Converted (2)`).
   - **Reprocess into existing folder** — adds any videos that aren't converted yet. Videos already in that folder are skipped. Nothing is deleted or overwritten.
   - **Cancel** — do nothing.

### 3. Watch the progress
You'll see how many videos are done (e.g. **12 / 27**), which video is being worked on, and a status for every video:

| Status | Meaning |
|---|---|
| ○ Waiting | In the queue |
| ⟳ Downloading | Copying the video from Google Drive to the converter |
| ⟳ Analyzing | Checking what kind of video it is |
| ⟳ Remuxing | Moving the video into an MP4 without changing the picture or sound (fast, no quality loss) |
| ⟳ Converting | Re-creating the video as MP4 (needed for some formats; takes longer) |
| ⟳ Checking | Making sure the new MP4 plays correctly before saving it |
| ⟳ Uploading | Saving the MP4 to the new Google Drive folder |
| ✓ Complete | Done |
| ✕ Failed | Could not be converted — see the error report |
| – Skipped | Not a video (e.g. audio only), empty, or already converted |

Large videos take time. You can close the page — conversion continues on the server, and when you come back to the Video Converter the progress screen reappears. **Stop converting** stops the batch; videos already finished stay in the output folder.

### 4. Open your converted videos
When finished you'll see a summary (**Total, Successful, Failed, Skipped**) and an **Open Converted Videos** button that opens the new folder in Google Drive.

- **If some videos failed**, each one shows where it failed, why, and what to do. Click **Retry failed videos** to try them again (they go into the same folder).
- **Detailed report** shows each video's original and converted details side by side (resolution, frame rate, length, audio) and any notes — for example, if an image-based subtitle couldn't be kept.

### What to expect from the converted files
- Same resolution (4K stays 4K), same frame rate, same orientation — phone videos filmed upright stay upright.
- Same length and all audio tracks.
- Same file name, just ending in `.mp4` (e.g. `Sunday_Service.MOV` → `Sunday_Service.mp4`). If two videos would end up with the same name, the second becomes `Name (2).mp4`.
- Videos that were already H.264 (most phones and many cameras) are copied into MP4 without any quality change. Others are converted at very high quality.

### Tips
- Very large folders (dozens of long 4K videos) can take hours. Start them when you don't need the results immediately.
- If a video fails as "Unreadable or unsupported file", try playing it on your computer. It may be a recording that was cut off or damaged.
- Converted videos use your Google Drive storage space.

---

## Church News

Open **Church News** from the home screen.

### 1. Add the news video
Click the box (or drag the video onto it) and choose the church news video from this computer. When it has uploaded, the computer starts writing down what is said. You can close the page; it keeps going.

- The first video downloads the speech model once (about 140 MB). If the internet drops, it carries on where it stopped next time.
- A 10-minute video takes roughly 8 minutes to transcribe on the office PC.
- If the presenter speaks another language, choose it under **Admin Settings → Church News**, and tick **Write the transcript in English** if you want it translated.

### 2. Check the posters needed
Each announcement that gives a date, time, place or way to sign up becomes a poster card with a headline and the details to print.

- Press **▶ said at…** to hear exactly what was said.
- Fix anything misheard (names and phone numbers especially). Changes save by themselves.
- Read the orange warnings: for example "next Sunday" must become a real date before printing.
- Tick **Poster made** when it is done. **+ Add poster** adds one the system missed. **Download list** gives a text file for the designer.

### 3. Transcript
Everything said, with times. Click a time to jump to it. Download it as text, or as subtitles (.srt) for video editing.

### 4. Make the news studio video (green screen videos)
1. **Video shape**: *Portrait* for phones and social media, *Landscape* for presentation screens.
2. **Presenter**: type the presenter's name and position or where they serve (for example *Youth Pastor, Soshanguve Branch*). The system never guesses names from the recording.
3. **Main headlines**: the big bar. Each headline appears at its time and stays until the next one. They are suggested from the posters; press ▶ to hear that part, correct the words or time, and tick **Checked**. **+ Add headline** adds one at the point where the video player is paused.
4. **Smaller headlines**: the moving bar along the bottom, one per line.
5. **Look**: the badge name, the church logo, and the red labels.
6. **Green removal**: press **Preview one frame**. If green still shows around the presenter, move the slider left; if parts of the presenter turn see-through, move it right. Use the size and position sliders to place the presenter.

Then press **Make news video**. This is slow on an ordinary computer (about 12 minutes per minute of video on the office PC), so start it and come back later. When it is finished, watch it on the page and press **Download MP4**.

### Tips
- News videos are kept on this computer, not in Google Drive. Delete old ones from the page to free up space.
- Film against an evenly lit green screen, and don't wear green: anything green disappears.

