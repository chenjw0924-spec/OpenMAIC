/**
 * Learning-pack artifacts generated from uploaded study material.
 *
 * These types deliberately stay separate from classroom scenes and quiz
 * attempts. A learning pack is a reusable study aid, while a classroom is an
 * authored lesson and a quiz attempt is learner activity.
 */

export type StudyPackSpeaker = 'host' | 'guest';

export interface StudyPackFlashcard {
  id: string;
  question: string;
  answer: string;
  hint?: string;
  source?: string;
}

export interface StudyPackDialogueTurn {
  id: string;
  speaker: StudyPackSpeaker;
  text: string;
  source?: string;
}

export interface StudyPackGeneration {
  title: string;
  summary: string;
  flashcards: StudyPackFlashcard[];
  dialogue: StudyPackDialogueTurn[];
}
