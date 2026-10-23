import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn, UpdateDateColumn } from 'typeorm';

@Entity('users')
export class User {
  @PrimaryGeneratedColumn('uuid') id: string;
  @Column({ unique: true }) email: string;
  @Column({ nullable: true }) password: string;
  @Column({ nullable: true }) githubId: string;
  @Column({ nullable: true }) githubUsername: string;
  @Column({ nullable: true }) githubAccessToken: string;
  @Column({ default: 'user' }) role: string;
  @Column({ default: true }) isActive: boolean;
  @CreateDateColumn() createdAt: Date;
  @UpdateDateColumn() updatedAt: Date;
}
