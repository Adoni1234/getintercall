import { TestBed } from '@angular/core/testing';

import { Transcribe } from './transcribe';

describe('Transcribe', () => {
  let service: Transcribe;

  beforeEach(() => {
    TestBed.configureTestingModule({});
    service = TestBed.inject(Transcribe);
  });

  it('should be created', () => {
    expect(service).toBeTruthy();
  });
});
