package egovframework.shop.member.service;

import java.util.List;
import egovframework.rte.psl.dataaccess.util.EgovMap;

public interface MemberService {
    Object selectMemberList(MemberVO vo) throws Exception;
    Object selectMember(MemberVO vo) throws Exception;
    Object selectMemberAddrList(MemberVO vo) throws Exception;
    Object updateMemberGrade(MemberVO vo) throws Exception;
    Object selectGradeList(MemberVO vo) throws Exception;
    Object updateGrade(MemberVO vo) throws Exception;
    Object selectDormantList(MemberVO vo) throws Exception;
}
