import { Injectable } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Observable } from 'rxjs';
import { environment } from '../../environments/environment';

@Injectable({
  providedIn: 'root'
})
export class Transcribe {


  private apiUrl = environment.apiUrl + '/transcribe';

  constructor(private http: HttpClient) {}

  transcribeChunk(blob: Blob): Observable<{ text: string }> {
    const extension = blob.type.includes('ogg') ? 'ogg' : 'webm'; // ← Dinámico
    const formData = new FormData();
    formData.append('file', blob, `chunk-${Date.now()}.${extension}`);

    return this.http.post<{ text: string }>(this.apiUrl, formData);
  }
}
